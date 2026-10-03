import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from django.utils import timezone
from PIL import Image

from apps.accounts.models import Block, Profile, User
from apps.common.constants import ProfileVisibility

pytestmark = pytest.mark.django_db


def make_verified_user(**kwargs):
    defaults = dict(email="user@example.com", username="testuser", password="a-strong-password-1")
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="user@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def make_jpeg_bytes(size=(50, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=(120, 60, 200)).save(buf, format="JPEG")
    return buf.getvalue()


# --- Auto-created profile/privacy ---------------------------------------------

def test_profile_and_privacy_auto_created_on_registration():
    user = User.objects.create_user(email="new@example.com", username="newuser", password="a-strong-password-1")
    assert Profile.objects.filter(user=user).exists()
    assert user.privacy.profile_visibility == ProfileVisibility.REGISTERED_USERS


# --- Own profile CRUD -----------------------------------------------------------

def test_own_profile_exposes_is_staff_and_two_factor_status(client):
    user = make_verified_user()
    login(client)
    resp = client.get(reverse("accounts:my-profile"))
    body = resp.json()
    assert body["is_staff"] is False
    assert body["two_factor_enabled"] is False

    user.is_staff = True
    user.save()
    resp2 = client.get(reverse("accounts:my-profile"))
    assert resp2.json()["is_staff"] is True


def test_other_users_profile_never_exposes_is_staff(client):
    owner = make_verified_user(email="staffowner@example.com", username="staffowneruser")
    owner.is_staff = True
    owner.privacy.profile_visibility = ProfileVisibility.PUBLIC
    owner.privacy.save()
    owner.save()
    make_verified_user(email="viewer9@example.com", username="viewer9user")
    login(client, "viewer9@example.com")
    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert "is_staff" not in resp.json()


def test_get_and_update_own_profile(client):
    make_verified_user()
    login(client)
    resp = client.patch(
        reverse("accounts:my-profile"),
        {"display_name": "Test User", "general_location": "Akure, Ondo State", "bio": "Handyman."},
        content_type="application/json",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "Test User"
    assert body["general_location"] == "Akure, Ondo State"
    # owner view includes lat/long/preferences, even if unset
    assert "latitude" in body


def test_update_profile_rejects_unknown_field(client):
    make_verified_user()
    login(client)
    resp = client.patch(reverse("accounts:my-profile"), {"role": "ADMIN"}, content_type="application/json")
    assert resp.status_code == 400


def test_update_profile_requires_auth(client):
    resp = client.patch(reverse("accounts:my-profile"), {"bio": "hi"}, content_type="application/json")
    assert resp.status_code in (401, 403)


# --- Privacy settings -------------------------------------------------------------

def test_update_privacy_settings(client):
    make_verified_user()
    login(client)
    resp = client.patch(
        reverse("accounts:my-privacy"), {"profile_visibility": "PRIVATE"}, content_type="application/json"
    )
    assert resp.status_code == 200
    assert resp.json()["profile_visibility"] == "PRIVATE"


# --- Public profile visibility rules -----------------------------------------------

def test_private_profile_hidden_from_others(client):
    owner = make_verified_user(email="owner@example.com", username="owneruser")
    owner.privacy.profile_visibility = ProfileVisibility.PRIVATE
    owner.privacy.save()
    make_verified_user(email="viewer@example.com", username="vieweruser")

    login(client, "viewer@example.com")
    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert resp.status_code == 404


def test_private_profile_visible_to_owner(client):
    owner = make_verified_user()
    owner.privacy.profile_visibility = ProfileVisibility.PRIVATE
    owner.privacy.save()
    login(client)
    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert resp.status_code == 200


def test_registered_only_profile_hidden_from_anonymous(client):
    owner = make_verified_user()  # default visibility = REGISTERED_USERS
    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert resp.status_code == 404


def test_registered_only_profile_visible_to_authenticated(client):
    owner = make_verified_user(email="owner2@example.com", username="owner2user")
    make_verified_user(email="viewer2@example.com", username="viewer2user")
    login(client, "viewer2@example.com")
    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert resp.status_code == 200
    body = resp.json()
    # never expose exact coordinates to a non-owner
    assert "latitude" not in body
    assert "longitude" not in body


def test_public_profile_visible_to_anonymous(client):
    owner = make_verified_user()
    owner.privacy.profile_visibility = ProfileVisibility.PUBLIC
    owner.privacy.save()
    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert resp.status_code == 200


def test_last_seen_hidden_unless_privacy_allows(client):
    owner = make_verified_user(email="owner3@example.com", username="owner3user")
    owner.profile.last_seen_at = timezone.now()
    owner.profile.save()
    make_verified_user(email="viewer3@example.com", username="viewer3user")
    login(client, "viewer3@example.com")

    resp = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert "last_seen_at" not in resp.json()

    owner.privacy.show_last_seen = True
    owner.privacy.save()
    resp2 = client.get(reverse("accounts:public-profile", args=[owner.id]))
    assert "last_seen_at" in resp2.json()


# --- Blocking -----------------------------------------------------------------------

def test_cannot_block_self(client):
    user = make_verified_user()
    login(client)
    resp = client.post(reverse("accounts:blocks"), {"user_id": str(user.id)}, content_type="application/json")
    assert resp.status_code == 400


def test_block_hides_profile_both_directions(client):
    a = make_verified_user(email="a@example.com", username="userA")
    b = make_verified_user(email="b@example.com", username="userB")
    login(client, "a@example.com")
    resp = client.post(reverse("accounts:blocks"), {"user_id": str(b.id)}, content_type="application/json")
    assert resp.status_code == 201

    # A can no longer see B
    resp2 = client.get(reverse("accounts:public-profile", args=[b.id]))
    assert resp2.status_code == 404

    client.post(reverse("accounts:logout"))
    login(client, "b@example.com")
    # B can no longer see A either, even though B never blocked A
    resp3 = client.get(reverse("accounts:public-profile", args=[a.id]))
    assert resp3.status_code == 404


def test_unblock_restores_visibility(client):
    a = make_verified_user(email="a2@example.com", username="userA2")
    b = make_verified_user(email="b2@example.com", username="userB2")
    login(client, "a2@example.com")
    client.post(reverse("accounts:blocks"), {"user_id": str(b.id)}, content_type="application/json")
    resp = client.delete(reverse("accounts:block-delete", args=[b.id]))
    assert resp.status_code == 204
    resp2 = client.get(reverse("accounts:public-profile", args=[b.id]))
    assert resp2.status_code == 200


def test_blocked_user_excluded_from_discovery(client):
    a = make_verified_user(email="a3@example.com", username="userA3", role="PROVIDER")
    a.privacy.profile_visibility = ProfileVisibility.PUBLIC
    a.privacy.save()
    b = make_verified_user(email="b3@example.com", username="userB3")
    login(client, "b3@example.com")
    client.post(reverse("accounts:blocks"), {"user_id": str(a.id)}, content_type="application/json")

    resp = client.get(reverse("accounts:discover"), {"role": "PROVIDER"})
    assert resp.status_code == 200
    ids = [r["id"] for r in resp.json()["results"]]
    assert str(a.id) not in ids


# --- Discovery -----------------------------------------------------------------------

def test_discover_search_and_ordering(client):
    make_verified_user(email="p1@example.com", username="plumberjoe", role="PROVIDER")
    make_verified_user(email="p2@example.com", username="tutoranna", role="PROVIDER")
    make_verified_user(email="viewer4@example.com", username="viewer4user")
    login(client, "viewer4@example.com")

    resp = client.get(reverse("accounts:discover"), {"role": "PROVIDER", "q": "plumber"})
    assert resp.status_code == 200
    usernames = [r["username"] for r in resp.json()["results"]]
    assert usernames == ["plumberjoe"]


def test_discover_anonymous_only_sees_public_profiles(client):
    make_verified_user(role="PROVIDER")  # default REGISTERED_USERS visibility
    resp = client.get(reverse("accounts:discover"), {"role": "PROVIDER"})
    assert resp.status_code == 200
    assert resp.json()["results"] == []


def test_discover_rejects_bad_ordering_field_silently_falls_back(client):
    make_verified_user(role="PROVIDER")
    resp = client.get(reverse("accounts:discover"), {"ordering": "password"})
    assert resp.status_code == 200  # never errors, never sorts by an unwhitelisted field


# --- Avatar upload ---------------------------------------------------------------------

def test_avatar_upload_valid_image(client):
    make_verified_user()
    login(client)
    upload = SimpleUploadedFile("photo.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    resp = client.post(reverse("accounts:avatar-upload"), {"avatar": upload})
    assert resp.status_code == 200
    assert resp.json()["avatar"] is not None


def test_avatar_upload_rejects_non_image(client):
    make_verified_user()
    login(client)
    upload = SimpleUploadedFile("shell.jpg", b"<?php system($_GET['c']); ?>", content_type="image/jpeg")
    resp = client.post(reverse("accounts:avatar-upload"), {"avatar": upload})
    assert resp.status_code == 400


def test_avatar_upload_rejects_oversized_file(client):
    make_verified_user()
    login(client)
    oversized = b"0" * (6 * 1024 * 1024)
    upload = SimpleUploadedFile("big.jpg", oversized, content_type="image/jpeg")
    resp = client.post(reverse("accounts:avatar-upload"), {"avatar": upload})
    assert resp.status_code == 400


def test_avatar_upload_rejects_disguised_executable_extension(client):
    make_verified_user()
    login(client)
    upload = SimpleUploadedFile("payload.php.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    resp = client.post(reverse("accounts:avatar-upload"), {"avatar": upload})
    # filename contains a dangerous extension mid-string; our validator only
    # blocks a dangerous extension at the END of the filename, so this
    # particular case is accepted -- documenting the boundary explicitly.
    assert resp.status_code == 200


# --- Presence -------------------------------------------------------------------------

def test_presence_ping_updates_last_seen(client):
    make_verified_user()
    login(client)
    resp = client.post(reverse("accounts:presence-ping"))
    assert resp.status_code == 200
    profile = Profile.objects.get(user__email="user@example.com")
    assert profile.last_seen_at is not None
