"""Age range / birth year / sex collected at sign-up, and what each viewer may see of it."""
import pytest
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import Profile, User
from apps.common.constants import AgeRange, Sex, age_range_for_age

pytestmark = pytest.mark.django_db

PW = "a-strong-password-1"


def register(client, **extra):
    body = {"email": "demo@example.com", "username": "demouser", "password": PW}
    body.update(extra)
    return client.post(reverse("accounts:register"), body, content_type="application/json")


def make_verified_user(**kwargs):
    defaults = dict(email="user@example.com", username="testuser", password=PW)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="user@example.com"):
    return client.post(reverse("accounts:login"), {"email": email, "password": PW}, content_type="application/json")


# --- band maths ----------------------------------------------------------------

@pytest.mark.parametrize("age,band", [
    (13, AgeRange.UNDER_16), (15, AgeRange.UNDER_16),
    (16, AgeRange.AGE_16_25), (25, AgeRange.AGE_16_25),
    (26, AgeRange.AGE_26_35), (35, AgeRange.AGE_26_35),
    (36, AgeRange.AGE_36_60), (39, AgeRange.AGE_36_60), (40, AgeRange.AGE_36_60), (60, AgeRange.AGE_36_60),
    (61, AgeRange.OVER_60), (90, AgeRange.OVER_60),
])
def test_age_to_band_has_no_gaps(age, band):
    assert age_range_for_age(age) == band


# --- registration --------------------------------------------------------------

def test_register_requires_an_age_range_or_birth_year(client):
    resp = register(client)
    assert resp.status_code == 400
    assert "age_range" in resp.json()
    assert not User.objects.filter(email="demo@example.com").exists()


def test_register_stores_band_and_sex(client):
    resp = register(client, age_range="AGE_16_25", sex="F")
    assert resp.status_code == 201
    profile = Profile.objects.get(user__email="demo@example.com")
    assert profile.age_range == AgeRange.AGE_16_25
    assert profile.sex == Sex.FEMALE
    assert profile.birth_year is None
    body = resp.json()  # sign-up response must not echo demographics
    assert "sex" not in body and "age_range" not in body


def test_sex_is_optional_and_defaults_to_undisclosed(client):
    assert register(client, age_range="AGE_26_35").status_code == 201
    assert Profile.objects.get(user__email="demo@example.com").sex == Sex.UNDISCLOSED


def test_prefer_not_to_say_is_kept_distinct_from_undisclosed(client):
    assert register(client, age_range="AGE_26_35", sex="PNS").status_code == 201
    assert Profile.objects.get(user__email="demo@example.com").sex == Sex.PREFER_NOT_TO_SAY


def test_register_rejects_unknown_sex_and_band(client):
    assert register(client, age_range="AGE_26_35", sex="X").status_code == 400
    assert register(client, age_range="AGE_1_5").status_code == 400


def test_birth_year_sets_the_band_and_beats_a_client_supplied_band(client):
    year = timezone.now().year - 30
    resp = register(client, birth_year=year, age_range="OVER_60")  # lying about the band
    assert resp.status_code == 201
    profile = Profile.objects.get(user__email="demo@example.com")
    assert profile.age_range == AgeRange.AGE_26_35
    assert profile.birth_year == year


def test_birth_year_below_minimum_age_is_refused(client):
    resp = register(client, birth_year=timezone.now().year - 9)
    assert resp.status_code == 400
    assert "birth_year" in resp.json()
    assert not User.objects.filter(email="demo@example.com").exists()


def test_birth_year_in_the_future_is_refused(client):
    assert register(client, birth_year=timezone.now().year + 1).status_code == 400


def test_band_follows_birth_year_as_time_passes():
    user = make_verified_user()
    profile = user.profile
    profile.birth_year = timezone.now().year - 25
    profile.age_range = AgeRange.AGE_16_25
    assert profile.effective_age_range == AgeRange.AGE_16_25
    profile.birth_year = timezone.now().year - 26  # a year later
    assert profile.effective_age_range == AgeRange.AGE_26_35


# --- who sees what ---------------------------------------------------------------

def test_other_users_see_the_band_but_never_sex_or_birth_year(client):
    target = make_verified_user(email="t@example.com", username="target")
    Profile.objects.filter(user=target).update(age_range="AGE_36_60", birth_year=timezone.now().year - 45, sex="M")
    make_verified_user(email="v@example.com", username="viewer")
    login(client, "v@example.com")
    resp = client.get(reverse("accounts:public-profile", args=[target.id]))
    assert resp.status_code == 200
    data = resp.json()
    assert data["age_range"] == AgeRange.AGE_36_60
    assert "sex" not in data and "birth_year" not in data


def test_discover_lists_expose_the_band_only(client):
    target = make_verified_user(email="t@example.com", username="target")
    Profile.objects.filter(user=target).update(age_range="OVER_60", sex="F")
    make_verified_user(email="v@example.com", username="viewer")
    login(client, "v@example.com")
    resp = client.get(reverse("accounts:discover"))
    assert resp.status_code == 200
    row = next(r for r in resp.json()["results"] if r["username"] == "target")
    assert row["age_range"] == AgeRange.OVER_60
    assert "sex" not in row and "birth_year" not in row


def test_owner_sees_own_sex_and_birth_year(client):
    user = make_verified_user()
    Profile.objects.filter(user=user).update(age_range="AGE_26_35", birth_year=timezone.now().year - 30, sex="F")
    login(client)
    data = client.get(reverse("accounts:my-profile")).json()
    assert data["sex"] == "F" and data["age_range"] == AgeRange.AGE_26_35
    assert data["birth_year"] == timezone.now().year - 30


def test_older_accounts_without_an_answer_have_an_empty_band(client):
    make_verified_user()
    login(client)
    data = client.get(reverse("accounts:my-profile")).json()
    assert data["age_range"] == "" and data["sex"] == Sex.UNDISCLOSED


# --- editing later ---------------------------------------------------------------

def test_user_can_update_sex_and_band(client):
    make_verified_user()
    login(client)
    resp = client.patch(reverse("accounts:my-profile"), {"sex": "PNS", "age_range": "AGE_16_25"}, content_type="application/json")
    assert resp.status_code == 200
    assert resp.json()["sex"] == "PNS" and resp.json()["age_range"] == "AGE_16_25"


def test_choosing_a_band_by_hand_drops_an_older_birth_year():
    from apps.accounts import services

    user = make_verified_user()
    services.update_profile(user, birth_year=timezone.now().year - 30)
    services.update_profile(user, age_range="OVER_60")
    user.profile.refresh_from_db()
    assert user.profile.birth_year is None
    assert user.profile.effective_age_range == AgeRange.OVER_60


def test_update_birth_year_below_minimum_is_refused(client):
    make_verified_user()
    login(client)
    resp = client.patch(reverse("accounts:my-profile"), {"birth_year": timezone.now().year - 5}, content_type="application/json")
    assert resp.status_code == 400


# --- Google sign-up --------------------------------------------------------------

def test_google_register_requires_age_and_stores_demographics(client, monkeypatch):
    monkeypatch.setattr(
        "apps.accounts.services._verify_google_token",
        lambda raw: {"email": "g@example.com", "name": "G Person", "email_verified": True},
    )
    url = reverse("accounts:google-register")
    base = {"id_token": "tok", "username": "googler", "password": PW}

    assert client.post(url, base, content_type="application/json").status_code == 400  # no age

    resp = client.post(url, {**base, "age_range": "OVER_60", "sex": "M"}, content_type="application/json")
    assert resp.status_code == 201
    profile = Profile.objects.get(user__email="g@example.com")
    assert profile.age_range == AgeRange.OVER_60 and profile.sex == Sex.MALE
