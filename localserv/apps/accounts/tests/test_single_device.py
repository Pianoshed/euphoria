"""One device at a time: logging in elsewhere asks first, then signs the old device out."""
import pyotp
import pytest
from django.contrib.sessions.models import Session
from django.test import Client
from django.urls import reverse

from apps.accounts.models import User, UserSession

pytestmark = pytest.mark.django_db

PW = "a-strong-password-1"
CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"
SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"


def make_user(**kw):
    defaults = dict(email="user@example.com", username="testuser", password=PW)
    defaults.update(kw)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def post_login(client, ua, email="user@example.com"):
    return client.post(
        reverse("accounts:login"), {"email": email, "password": PW},
        content_type="application/json", HTTP_USER_AGENT=ua,
    )


def signed_in(client) -> bool:
    return client.get(reverse("accounts:my-profile")).status_code == 200


def test_first_login_just_works():
    make_user()
    resp = post_login(Client(), CHROME_WIN)
    assert resp.status_code == 200
    assert resp.json()["user"]["username"] == "testuser"
    assert "session_conflict" not in resp.json()


def test_second_device_is_asked_first_and_not_logged_in():
    make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)

    resp = post_login(phone, SAFARI_IPHONE)
    body = resp.json()
    assert resp.status_code == 200
    assert body["session_conflict"] is True and body["challenge"]
    assert "user" not in body
    assert body["devices"][0]["device"] == "Chrome on Windows"
    assert "ip" not in body["devices"][0] and "ip_address" not in body["devices"][0]
    assert not signed_in(phone)          # nothing was granted yet
    assert signed_in(laptop)             # and the first device is untouched


def test_confirming_signs_the_other_device_out():
    make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)
    challenge = post_login(phone, SAFARI_IPHONE).json()["challenge"]

    resp = phone.post(reverse("accounts:login-confirm-device"), {"challenge": challenge}, content_type="application/json")
    assert resp.status_code == 200 and resp.json()["user"]["username"] == "testuser"
    assert signed_in(phone)
    assert not signed_in(laptop)
    assert UserSession.objects.filter(user__email="user@example.com", revoked_at__isnull=True).count() == 1


def test_declining_leaves_everything_as_it_was():
    make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)
    post_login(phone, SAFARI_IPHONE)  # the person walks away from the prompt
    assert signed_in(laptop) and not signed_in(phone)


def test_logging_in_again_in_the_same_browser_is_not_a_conflict():
    make_user()
    laptop = Client()
    post_login(laptop, CHROME_WIN)
    assert "session_conflict" not in post_login(laptop, CHROME_WIN).json()


def test_a_dead_session_does_not_block_a_new_login():
    user = make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)
    Session.objects.all().delete()  # the laptop's session expired without a logout
    resp = post_login(phone, SAFARI_IPHONE)
    assert "session_conflict" not in resp.json()
    assert signed_in(phone)
    assert UserSession.objects.filter(user=user, revoked_at__isnull=True).count() == 1  # stale row was closed


def test_bad_or_tampered_challenge_is_refused():
    make_user()
    resp = Client().post(reverse("accounts:login-confirm-device"), {"challenge": "nope"}, content_type="application/json")
    assert resp.status_code == 401


def test_challenge_cannot_be_used_after_it_expires(monkeypatch):
    make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)
    challenge = post_login(phone, SAFARI_IPHONE).json()["challenge"]
    monkeypatch.setattr("apps.accounts.services.TAKEOVER_TTL_SECONDS", -1)
    resp = phone.post(reverse("accounts:login-confirm-device"), {"challenge": challenge}, content_type="application/json")
    assert resp.status_code == 401
    assert signed_in(laptop)


def test_suspended_account_cannot_take_over():
    user = make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)
    challenge = post_login(phone, SAFARI_IPHONE).json()["challenge"]
    user.status = "SUSPENDED"
    user.save(update_fields=["status"])
    resp = phone.post(reverse("accounts:login-confirm-device"), {"challenge": challenge}, content_type="application/json")
    assert resp.status_code >= 400 and not signed_in(phone)


def test_two_factor_login_also_asks_before_taking_over():
    secret = pyotp.random_base32()
    make_user(two_factor_enabled=True, two_factor_secret=secret)
    laptop, phone = Client(), Client()
    laptop_mfa = post_login(laptop, CHROME_WIN).json()["challenge"]
    laptop.post(reverse("accounts:login-verify-2fa"), {"challenge": laptop_mfa, "code": pyotp.TOTP(secret).now()}, content_type="application/json")
    assert signed_in(laptop)

    phone_mfa = post_login(phone, SAFARI_IPHONE).json()["challenge"]
    resp = phone.post(reverse("accounts:login-verify-2fa"), {"challenge": phone_mfa, "code": pyotp.TOTP(secret).now()}, content_type="application/json")
    assert resp.json()["session_conflict"] is True
    assert not signed_in(phone) and signed_in(laptop)


def test_google_login_also_asks(monkeypatch):
    make_user(email="g@example.com", username="googler")
    monkeypatch.setattr("apps.accounts.services._verify_google_token",
                        lambda raw: {"email": "g@example.com", "name": "G", "email_verified": True})
    laptop, phone = Client(), Client()
    assert laptop.post(reverse("accounts:google-login"), {"id_token": "t"}, content_type="application/json").json()["needs_signup"] is False
    resp = phone.post(reverse("accounts:google-login"), {"id_token": "t"}, content_type="application/json")
    body = resp.json()
    assert body["needs_signup"] is False and body["session_conflict"] is True
    assert not signed_in(phone)


def test_rule_can_be_switched_off(settings):
    settings.SINGLE_DEVICE_LOGIN = False
    make_user()
    laptop, phone = Client(), Client()
    post_login(laptop, CHROME_WIN)
    assert "session_conflict" not in post_login(phone, SAFARI_IPHONE).json()
    assert signed_in(laptop) and signed_in(phone)
