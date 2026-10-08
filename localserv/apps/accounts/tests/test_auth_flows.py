import pyotp
import pytest
from django.urls import reverse
from django.utils import timezone
from datetime import timedelta

from apps.accounts.models import EmailVerificationToken, PasswordResetToken, User, UserSession
from apps.accounts.tokens import generate_raw_token, hash_token
from apps.common.constants import AccountStatus

pytestmark = pytest.mark.django_db


def make_verified_user(**kwargs):
    defaults = dict(email="user@example.com", username="testuser", password="a-strong-password-1")
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


# --- Registration & verification --------------------------------------------

def test_register_creates_pending_user_and_token(client):
    resp = client.post(
        reverse("accounts:register"),
        {"email": "New@Example.com", "username": "newuser", "password": "a-strong-password-1"},
        content_type="application/json",
    )
    assert resp.status_code == 201
    user = User.objects.get(email="new@example.com")
    assert user.status == AccountStatus.PENDING_VERIFICATION
    assert EmailVerificationToken.objects.filter(user=user).exists()
    # password must never appear in the response
    assert "password" not in resp.json()


def test_register_weak_password_rejected(client):
    resp = client.post(
        reverse("accounts:register"),
        {"email": "weak@example.com", "username": "weakuser", "password": "12345678"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_register_duplicate_email_and_username_is_a_clean_400(client):
    make_verified_user(email="taken@example.com", username="takenname")
    resp = client.post(
        reverse("accounts:register"),
        {"email": "Taken@Example.com", "username": "TakenName", "password": "a-strong-password-1"},
        content_type="application/json",
    )
    assert resp.status_code == 400
    body = resp.json()
    assert "already exists" in body["email"][0]
    assert "taken" in body["username"][0]


def test_register_survives_verification_email_failure(client, monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("smtp down")

    monkeypatch.setattr("apps.accounts.emails.send_verification_email", boom)
    resp = client.post(
        reverse("accounts:register"),
        {"email": "mail@example.com", "username": "mailuser", "password": "a-strong-password-1"},
        content_type="application/json",
    )
    assert resp.status_code == 201
    assert User.objects.filter(email="mail@example.com").exists()


def test_register_defaults_to_customer_role(client):
    resp = client.post(
        reverse("accounts:register"),
        {"email": "defaultrole@example.com", "username": "defaultroleuser", "password": "a-strong-password-1"},
        content_type="application/json",
    )
    assert resp.status_code == 201
    assert resp.json()["role"] == "CUSTOMER"


def test_register_can_self_select_provider_role(client):
    resp = client.post(
        reverse("accounts:register"),
        {
            "email": "provider1@example.com", "username": "provider1user",
            "password": "a-strong-password-1", "role": "PROVIDER",
        },
        content_type="application/json",
    )
    assert resp.status_code == 201
    assert resp.json()["role"] == "PROVIDER"
    user = User.objects.get(email="provider1@example.com")
    assert user.role == "PROVIDER"


def test_register_cannot_self_select_privileged_role(client):
    resp = client.post(
        reverse("accounts:register"),
        {
            "email": "sneaky@example.com", "username": "sneakyuser",
            "password": "a-strong-password-1", "role": "ADMIN",
        },
        content_type="application/json",
    )
    assert resp.status_code == 400
    assert not User.objects.filter(email="sneaky@example.com").exists()


def test_verify_email_activates_account(client):
    user = User.objects.create_user(email="verify@example.com", username="verifyuser", password="a-strong-password-1")
    raw = generate_raw_token()
    EmailVerificationToken.objects.create(
        user=user, token_hash=hash_token(raw),
        expires_at=timezone.now() + timedelta(hours=1),
    )
    resp = client.post(reverse("accounts:verify-email"), {"token": raw}, content_type="application/json")
    assert resp.status_code == 200
    user.refresh_from_db()
    assert user.status == AccountStatus.ACTIVE


def test_verify_email_bad_token_rejected(client):
    resp = client.post(reverse("accounts:verify-email"), {"token": "not-a-real-token"}, content_type="application/json")
    assert resp.status_code == 400


def test_verify_email_token_is_single_use(client):
    user = User.objects.create_user(email="reuse@example.com", username="reuseuser", password="a-strong-password-1")
    raw = generate_raw_token()
    EmailVerificationToken.objects.create(
        user=user, token_hash=hash_token(raw), expires_at=timezone.now() + timedelta(hours=1)
    )
    first = client.post(reverse("accounts:verify-email"), {"token": raw}, content_type="application/json")
    second = client.post(reverse("accounts:verify-email"), {"token": raw}, content_type="application/json")
    assert first.status_code == 200
    assert second.status_code == 400


def test_resend_verification_gives_generic_response_for_unknown_email(client):
    resp = client.post(
        reverse("accounts:resend-verification"), {"email": "nobody@example.com"}, content_type="application/json"
    )
    assert resp.status_code == 200
    assert "detail" in resp.json()


# --- Login -------------------------------------------------------------------

def test_login_wrong_password_rejected_generically(client):
    make_verified_user()
    resp = client.post(
        reverse("accounts:login"), {"email": "user@example.com", "password": "wrong-password"}, content_type="application/json"
    )
    assert resp.status_code in (400, 401, 403)
    assert "password" not in resp.json().get("detail", "").lower() or "incorrect" not in resp.json().get("detail", "").lower()


def test_login_unverified_account_blocked(client):
    User.objects.create_user(email="pending@example.com", username="pendinguser", password="a-strong-password-1")
    resp = client.post(
        reverse("accounts:login"), {"email": "pending@example.com", "password": "a-strong-password-1"}, content_type="application/json"
    )
    assert resp.status_code == 400


def test_login_success_creates_session_record(client):
    make_verified_user()
    resp = client.post(
        reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mfa_required"] is False
    assert UserSession.objects.filter(user__email="user@example.com", revoked_at__isnull=True).exists()


def test_login_with_2fa_requires_challenge_then_code(client):
    user = make_verified_user()
    secret = pyotp.random_base32()
    user.two_factor_secret = secret
    user.two_factor_enabled = True
    user.save()

    resp = client.post(
        reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mfa_required"] is True
    assert not UserSession.objects.filter(user=user).exists()  # not logged in yet

    code = pyotp.TOTP(secret).now()
    resp2 = client.post(
        reverse("accounts:login-verify-2fa"), {"challenge": body["challenge"], "code": code}, content_type="application/json"
    )
    assert resp2.status_code == 200
    assert UserSession.objects.filter(user=user, revoked_at__isnull=True).exists()


def test_login_with_2fa_wrong_code_rejected(client):
    user = make_verified_user()
    secret = pyotp.random_base32()
    user.two_factor_secret = secret
    user.two_factor_enabled = True
    user.save()

    resp = client.post(
        reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json"
    )
    challenge = resp.json()["challenge"]
    resp2 = client.post(
        reverse("accounts:login-verify-2fa"), {"challenge": challenge, "code": "000000"}, content_type="application/json"
    )
    assert resp2.status_code in (400, 401, 403)
    assert not UserSession.objects.filter(user=user).exists()


# --- Logout & sessions ---------------------------------------------------------

def test_logout_revokes_session(client):
    make_verified_user()
    client.post(reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    session = UserSession.objects.get(user__email="user@example.com")
    resp = client.post(reverse("accounts:logout"))
    assert resp.status_code == 204
    session.refresh_from_db()
    assert session.revoked_at is not None


def test_session_list_and_revoke(client):
    user = make_verified_user()
    client.post(reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    resp = client.get(reverse("accounts:sessions"))
    assert resp.status_code == 200
    assert len(resp.json()) == 1

    other = UserSession.objects.create(user=user, session_key="deadbeefdeadbeefdeadbeefdeadbeef")
    resp2 = client.post(reverse("accounts:session-revoke", args=[other.id]))
    assert resp2.status_code == 204
    other.refresh_from_db()
    assert other.revoked_at is not None


# --- Password reset & change ---------------------------------------------------

def test_password_reset_request_generic_for_unknown_email(client):
    resp = client.post(reverse("accounts:password-reset"), {"email": "ghost@example.com"}, content_type="application/json")
    assert resp.status_code == 200


def test_password_reset_confirm_changes_password_and_revokes_sessions(client):
    user = make_verified_user()
    client.post(reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    assert UserSession.objects.filter(user=user, revoked_at__isnull=True).exists()

    raw = generate_raw_token()
    PasswordResetToken.objects.create(user=user, token_hash=hash_token(raw), expires_at=timezone.now() + timedelta(hours=1))

    resp = client.post(
        reverse("accounts:password-reset-confirm"),
        {"token": raw, "new_password": "a-new-strong-password-2"},
        content_type="application/json",
    )
    assert resp.status_code == 200
    user.refresh_from_db()
    assert user.check_password("a-new-strong-password-2")
    assert not UserSession.objects.filter(user=user, revoked_at__isnull=True).exists()


# --- Google accounts: setting a first password ---------------------------------

def make_google_user(**kwargs):
    defaults = dict(email="g@example.com", username="googler")  # no password => unusable, like Google sign-up
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def test_profile_me_reports_password_state_and_email(client):
    google_user = make_google_user()
    client.force_login(google_user)
    data = client.get(reverse("accounts:my-profile")).json()
    assert data["has_usable_password"] is False
    assert data["email"] == "g@example.com"

    client.logout()
    client.force_login(make_verified_user())
    assert client.get(reverse("accounts:my-profile")).json()["has_usable_password"] is True


def test_2fa_disable_for_account_without_password_explains_next_step(client):
    user = make_google_user(two_factor_enabled=True, two_factor_secret=pyotp.random_base32())
    client.force_login(user)
    resp = client.post(reverse("accounts:2fa-disable"), {"password": "anything"}, content_type="application/json")
    assert resp.status_code == 400
    assert "Set a password" in str(resp.json())
    user.refresh_from_db()
    assert user.two_factor_enabled is True


# --- 2FA setup/disable ----------------------------------------------------------

def test_2fa_setup_and_confirm(client):
    make_verified_user()
    client.post(reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json")

    setup_resp = client.post(reverse("accounts:2fa-setup"))
    assert setup_resp.status_code == 200
    secret = setup_resp.json()["secret"]

    user = User.objects.get(email="user@example.com")
    assert user.two_factor_enabled is False  # not enabled until confirmed

    code = pyotp.TOTP(secret).now()
    confirm_resp = client.post(reverse("accounts:2fa-confirm"), {"code": code}, content_type="application/json")
    assert confirm_resp.status_code == 200
    user.refresh_from_db()
    assert user.two_factor_enabled is True


def test_2fa_disable_requires_password(client):
    make_verified_user()
    client.post(reverse("accounts:login"), {"email": "user@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    secret = client.post(reverse("accounts:2fa-setup")).json()["secret"]
    client.post(reverse("accounts:2fa-confirm"), {"code": pyotp.TOTP(secret).now()}, content_type="application/json")

    resp = client.post(reverse("accounts:2fa-disable"), {"password": "wrong"}, content_type="application/json")
    assert resp.status_code == 400
    user = User.objects.get(email="user@example.com")
    assert user.two_factor_enabled is True

    resp2 = client.post(reverse("accounts:2fa-disable"), {"password": "a-strong-password-1"}, content_type="application/json")
    assert resp2.status_code == 200
    user.refresh_from_db()
    assert user.two_factor_enabled is False


def test_csrf_bootstrap_sets_cookie(client):
    resp = client.get(reverse("accounts:csrf"))
    assert resp.status_code == 200
    assert "csrftoken" in resp.cookies


# --- Password: emailed reset link instead of "old + new password" -----------------

def test_old_password_change_endpoint_is_gone(client):
    client.get(reverse("accounts:csrf"))
    resp = client.post("/api/accounts/password/change/", {"old_password": "x", "new_password": "y"}, content_type="application/json")
    assert resp.status_code == 404


def test_signed_in_user_can_email_themselves_a_reset_link(client, mailoutbox):
    user = make_verified_user()
    client.force_login(user)
    resp = client.post(reverse("accounts:password-reset-self"), content_type="application/json")
    assert resp.status_code == 200
    assert PasswordResetToken.objects.filter(user=user, used_at__isnull=True).exists()
    assert len(mailoutbox) == 1
    assert mailoutbox[0].to == [user.email]


def test_google_account_can_use_reset_link_to_set_first_password(client, mailoutbox):
    user = make_google_user()
    client.force_login(user)
    assert client.post(reverse("accounts:password-reset-self"), content_type="application/json").status_code == 200
    assert len(mailoutbox) == 1


def test_reset_self_requires_login(client):
    resp = client.post(reverse("accounts:password-reset-self"), content_type="application/json")
    assert resp.status_code in (401, 403)
    assert not PasswordResetToken.objects.exists()
