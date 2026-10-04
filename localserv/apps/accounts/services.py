from datetime import timedelta


import re
from django.db import IntegrityError, transaction
from google.auth.exceptions import GoogleAuthError
from django.contrib.auth import authenticate
from django.contrib.auth import login as django_login
from django.contrib.auth.password_validation import validate_password
from django.contrib.sessions.backends.db import SessionStore
from django.core import signing
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, ValidationError

import pyotp

from apps.common.constants import AccountRole, AccountStatus, ProfileVisibility
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size, get_client_ip, whitelist_ordering

from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests
from django.conf import settings

from . import emails
from .media_utils import process_avatar_upload
from .models import (
    Block,
    EmailVerificationToken,
    PasswordResetToken,
    Profile,
    ProfilePrivacy,
    User,
    UserSession,
)
from .tokens import generate_raw_token, hash_token, tokens_match

EMAIL_TOKEN_TTL = timedelta(hours=24)
PASSWORD_RESET_TOKEN_TTL = timedelta(hours=1)
MFA_CHALLENGE_TTL_SECONDS = 300
MFA_SIGNING_SALT = "accounts.mfa-challenge"

# Generic messages -- deliberately identical whether or not the email
# exists, so these endpoints can't be used to enumerate accounts.
GENERIC_AUTH_ERROR = "Invalid email or password."
GENERIC_RESET_SENT = "If an account exists for this email, password reset instructions have been sent."
GENERIC_VERIFICATION_SENT = "If an account exists for this email and is unverified, a verification link has been sent."


# --- Registration & email verification -------------------------------------

@transaction.atomic
def register_user(*, email: str, username: str, password: str, role: str = AccountRole.CUSTOMER) -> User:
    try:
        validate_password(password)
    except DjangoValidationError as exc:
        raise ValidationError({"password": list(exc.messages)}) from exc

    user = User.objects.create_user(email=email, username=username, password=password, role=role)
    _issue_email_verification_token(user)
    return user


def _issue_email_verification_token(user: User) -> str:
    raw_token = generate_raw_token()
    EmailVerificationToken.objects.create(
        user=user,
        token_hash=hash_token(raw_token),
        expires_at=timezone.now() + EMAIL_TOKEN_TTL,
    )
    emails.send_verification_email(user, raw_token)
    return raw_token


def resend_verification_email(*, email: str) -> None:
    try:
        user = User.objects.get(email=email.lower())
    except User.DoesNotExist:
        return  # caller always returns the generic message regardless
    if user.email_verified:
        return
    _issue_email_verification_token(user)


@transaction.atomic
def verify_email(*, raw_token: str) -> User:
    token_hash = hash_token(raw_token)
    try:
        token = EmailVerificationToken.objects.select_for_update().get(token_hash=token_hash)
    except EmailVerificationToken.DoesNotExist as exc:
        raise DomainError("This verification link is invalid.") from exc

    if not token.is_valid:
        raise DomainError("This verification link has expired or was already used.")

    token.used_at = timezone.now()
    token.save(update_fields=["used_at"])

    user = token.user
    user.mark_email_verified()
    return user


# --- Login / 2FA challenge ---------------------------------------------------

def _record_session(request, user: User) -> UserSession:
    """Record (or refresh) the UserSession row for the current Django session.

    This must be update_or_create, not create. Django's login() only rotates the
    session key when the browser has no authenticated session yet. If the same
    person logs in again from a browser that is already signed in (a second tab,
    Google login after a password login, a retry after a half-finished login),
    the session key stays the same, and a plain create() hits the unique
    constraint on session_key and the request fails with a 500.
    """
    if not request.session.session_key:
        request.session.save()
    session, _created = UserSession.objects.update_or_create(
        session_key=request.session.session_key,
        defaults={
            "user": user,
            "user_agent": request.META.get("HTTP_USER_AGENT", "")[:255],
            "ip_address": get_client_ip(request),
            "revoked_at": None,  # a re-used key is a live session again, not a revoked one
        },
    )
    return session


def _finish_login(request, user: User) -> User:
    django_login(request, user)  # first: it may rotate the key, so record the session after it
    _record_session(request, user)
    user.last_login_ip = get_client_ip(request)
    user.save(update_fields=["last_login_ip"])
    return user


def _check_account_usable(user: User) -> None:
    if user.status == AccountStatus.SUSPENDED:
        raise DomainError("Your account is suspended. Contact support for help.")
    if user.status == AccountStatus.BANNED:
        raise DomainError("This account has been banned.")
    if user.status == AccountStatus.DEACTIVATED:
        raise DomainError("This account has been deactivated.")
    if user.status == AccountStatus.PENDING_VERIFICATION:
        raise DomainError("Please verify your email address before logging in.")


def authenticate_login(request, *, email: str, password: str) -> dict:
    """Returns either {"user": user} on full login, or
    {"mfa_challenge": token} if the account requires a second factor.
    Never creates a session until the correct factor(s) are supplied."""
    user = authenticate(request, username=email.lower(), password=password)
    if user is None:
        raise AuthenticationFailed(GENERIC_AUTH_ERROR)

    _check_account_usable(user)

    if user.two_factor_enabled:
        challenge = signing.dumps({"user_id": str(user.id)}, salt=MFA_SIGNING_SALT)
        return {"mfa_challenge": challenge}

    _finish_login(request, user)
    return {"user": user}


def verify_login_mfa(request, *, challenge: str, code: str) -> User:
    try:
        payload = signing.loads(challenge, salt=MFA_SIGNING_SALT, max_age=MFA_CHALLENGE_TTL_SECONDS)
    except signing.BadSignature as exc:
        raise AuthenticationFailed("This login attempt has expired. Please log in again.") from exc

    try:
        user = User.objects.get(id=payload["user_id"])
    except User.DoesNotExist as exc:
        raise AuthenticationFailed(GENERIC_AUTH_ERROR) from exc

    _check_account_usable(user)

    if not user.two_factor_enabled or not _totp_valid(user, code):
        raise AuthenticationFailed("Invalid authentication code.")

    _finish_login(request, user)
    return user


def logout_user(request) -> None:
    session_key = request.session.session_key
    if session_key:
        UserSession.objects.filter(session_key=session_key, revoked_at__isnull=True).update(
            revoked_at=timezone.now()
        )
    from django.contrib.auth import logout as django_logout

    django_logout(request)


# --- Password reset & change --------------------------------------------------

def request_password_reset(*, email: str) -> None:
    try:
        user = User.objects.get(email=email.lower())
    except User.DoesNotExist:
        return  # caller always returns the generic message regardless
    raw_token = generate_raw_token()
    PasswordResetToken.objects.create(
        user=user,
        token_hash=hash_token(raw_token),
        expires_at=timezone.now() + PASSWORD_RESET_TOKEN_TTL,
    )
    emails.send_password_reset_email(user, raw_token)


@transaction.atomic
def confirm_password_reset(*, raw_token: str, new_password: str) -> User:
    token_hash = hash_token(raw_token)
    try:
        token = PasswordResetToken.objects.select_for_update().get(token_hash=token_hash)
    except PasswordResetToken.DoesNotExist as exc:
        raise DomainError("This reset link is invalid.") from exc

    if not token.is_valid:
        raise DomainError("This reset link has expired or was already used.")

    user = token.user
    try:
        validate_password(new_password, user=user)
    except DjangoValidationError as exc:
        raise ValidationError({"new_password": list(exc.messages)}) from exc

    user.set_password(new_password)
    user.save(update_fields=["password"])

    token.used_at = timezone.now()
    token.save(update_fields=["used_at"])

    # A password reset is a strong signal of possible account
    # compromise recovery -- invalidate every other active session and
    # unused reset token so a prior attacker session can't persist.
    _revoke_all_sessions(user)
    PasswordResetToken.objects.filter(user=user, used_at__isnull=True).exclude(id=token.id).update(
        used_at=timezone.now()
    )
    emails.send_security_alert_email(
        user,
        subject="Your password was reset",
        body="Your password was just reset. If this wasn't you, contact support immediately.",
    )
    return user


def change_password(
    user: User, *, new_password: str, old_password: str = "", keep_session_key: str | None = None
) -> None:
    """Change the password, or set the FIRST one for an account that has none.

    Accounts created through Google sign-in have an unusable password, so there is no current
    password to ask for. Anyone who already has a password must still prove they know it.
    Either way every other session is signed out and an alert email goes to the owner.
    """
    had_password = user.has_usable_password()
    if had_password and not user.check_password(old_password):
        raise DomainError("Current password is incorrect.")
    try:
        validate_password(new_password, user=user)
    except DjangoValidationError as exc:
        raise ValidationError({"new_password": list(exc.messages)}) from exc

    user.set_password(new_password)
    user.save(update_fields=["password"])
    _revoke_all_sessions(user, except_session_key=keep_session_key)
    if had_password:
        emails.send_security_alert_email(
            user,
            subject="Your password was changed",
            body="Your password was just changed. If this wasn't you, contact support immediately.",
        )
    else:
        emails.send_security_alert_email(
            user,
            subject="A password was added to your account",
            body="A password was just set on your account, so you can now also log in with your email. "
            "If this wasn't you, contact support immediately.",
        )


# --- Session management -------------------------------------------------------

def list_sessions(user: User):
    return UserSession.objects.filter(user=user, revoked_at__isnull=True).order_by("-last_seen_at")


def revoke_session(user: User, *, session_id) -> None:
    try:
        session = UserSession.objects.get(id=session_id, user=user, revoked_at__isnull=True)
    except UserSession.DoesNotExist as exc:
        raise DomainError("Session not found.") from exc
    _revoke_one(session)


def revoke_all_sessions(user: User, *, keep_session_key: str | None = None) -> None:
    _revoke_all_sessions(user, except_session_key=keep_session_key)


def _revoke_one(session: UserSession) -> None:
    session.revoked_at = timezone.now()
    session.save(update_fields=["revoked_at"])
    SessionStore(session_key=session.session_key).delete()


def _revoke_all_sessions(user: User, *, except_session_key: str | None = None) -> None:
    qs = UserSession.objects.filter(user=user, revoked_at__isnull=True)
    if except_session_key:
        qs = qs.exclude(session_key=except_session_key)
    for session in qs:
        _revoke_one(session)


# --- Two-factor authentication -------------------------------------------------

def _totp_valid(user: User, code: str) -> bool:
    if not user.two_factor_secret or not code:
        return False
    return pyotp.TOTP(user.two_factor_secret).verify(code, valid_window=1)


def start_2fa_setup(user: User) -> dict:
    # Without this guard, any signed-in session could replace the secret of an account that
    # already has 2FA on, locking the real owner out of their authenticator app.
    if user.two_factor_enabled:
        raise DomainError("Two-factor authentication is already enabled. Disable it first.")
    secret = pyotp.random_base32()
    user.two_factor_secret = secret
    user.save(update_fields=["two_factor_secret"])
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="Euphoria")
    return {"secret": secret, "provisioning_uri": uri}


def confirm_2fa_setup(user: User, *, code: str) -> None:
    if not _totp_valid(user, code):
        raise DomainError("Invalid authentication code.")
    user.two_factor_enabled = True
    user.save(update_fields=["two_factor_enabled"])
    emails.send_security_alert_email(
        user,
        subject="Two-factor authentication enabled",
        body="Two-factor authentication was just enabled on your account.",
    )


def disable_2fa(user: User, *, password: str) -> None:
    # Sensitive action: require the current password again even though
    # the request is already authenticated (recent-reauth pattern).
    if not user.has_usable_password():
        # Google sign-ups have no password to confirm with until they set one.
        raise DomainError("Set a password in your profile first, then you can turn two-factor off.")
    if not user.check_password(password):
        raise DomainError("Current password is incorrect.")
    user.two_factor_enabled = False
    user.two_factor_secret = ""
    user.save(update_fields=["two_factor_enabled", "two_factor_secret"])
    emails.send_security_alert_email(
        user,
        subject="Two-factor authentication disabled",
        body="Two-factor authentication was just disabled on your account. "
        "If this wasn't you, contact support immediately.",
    )


# --- Profile -------------------------------------------------------------------

PROFILE_UPDATABLE_FIELDS = {
    "display_name", "bio", "general_location", "latitude", "longitude",
    "availability", "preferences",
}


def update_profile(user: User, **fields) -> Profile:
    profile = user.profile
    unknown = set(fields) - PROFILE_UPDATABLE_FIELDS
    if unknown:
        raise ValidationError({f: ["This field cannot be updated here."] for f in unknown})
    for field, value in fields.items():
        setattr(profile, field, value)
    profile.full_clean(exclude=["user", "avatar"])
    profile.save(update_fields=list(fields.keys()) + ["updated_at"])
    return profile


def update_privacy(user: User, **fields) -> ProfilePrivacy:
    privacy = user.privacy
    for field, value in fields.items():
        setattr(privacy, field, value)
    privacy.full_clean(exclude=["user"])
    privacy.save(update_fields=list(fields.keys()) + ["updated_at"])
    return privacy


def upload_avatar(user: User, uploaded_file) -> Profile:
    processed = process_avatar_upload(uploaded_file)
    profile = user.profile
    old_name = profile.avatar.name if profile.avatar else None
    profile.avatar.save("avatar.jpg", processed, save=True)
    if old_name:
        profile.avatar.storage.delete(old_name)
    return profile


def touch_presence(user: User) -> None:
    Profile.objects.filter(user=user).update(last_seen_at=timezone.now())


def _is_blocked_either_direction(user_a_id, user_b_id) -> bool:
    return Block.objects.filter(
        Q(blocker_id=user_a_id, blocked_id=user_b_id) | Q(blocker_id=user_b_id, blocked_id=user_a_id)
    ).exists()


def is_blocked_between(user_a_id, user_b_id) -> bool:
    """Public wrapper around _is_blocked_either_direction for
    cross-app use (apps.chat needs this to gate conversation creation,
    every message send, and every WebSocket connection attempt)."""
    return _is_blocked_either_direction(user_a_id, user_b_id)


def get_public_profile(viewer, target_user: User) -> dict | None:
    """Returns a plain dict of the visible fields, or None if the
    viewer is not permitted to see this profile at all (caller should
    treat None as a 404 -- not revealing WHY keeps blocks/private
    profiles indistinguishable from a profile that doesn't exist)."""
    is_owner = bool(viewer and viewer.is_authenticated and viewer.id == target_user.id)

    if not is_owner and viewer and viewer.is_authenticated:
        if _is_blocked_either_direction(viewer.id, target_user.id):
            return None

    if target_user.status not in (AccountStatus.ACTIVE,) and not is_owner:
        return None

    privacy = target_user.privacy
    visibility = privacy.profile_visibility

    if not is_owner:
        if visibility == ProfileVisibility.PRIVATE:
            return None
        if visibility == ProfileVisibility.REGISTERED_USERS and not (viewer and viewer.is_authenticated):
            return None

    profile = target_user.profile
    data = {
        "id": str(target_user.id),
        "username": target_user.username,
        "display_name": profile.effective_display_name,
        "bio": profile.bio,
        "avatar": profile.avatar.url if profile.avatar else None,
        "general_location": profile.general_location,
        "availability": profile.availability,
        "role": target_user.role,
    }
    if is_owner or privacy.show_online_status:
        data["online"] = _is_online(profile)
    if is_owner or privacy.show_last_seen:
        data["last_seen_at"] = profile.last_seen_at
    if is_owner:
        data["preferences"] = profile.preferences
        data["latitude"] = profile.latitude
        data["longitude"] = profile.longitude
        # Needed by the frontend to gate staff-only UI (moderation,
        # dispute resolution) and show 2FA status -- both self-only,
        # never included for any other viewer.
        data["is_staff"] = target_user.is_staff
        data["two_factor_enabled"] = target_user.two_factor_enabled
        # Self-only: lets the profile page offer "Set a password" to Google sign-ups
        # (who have none) and "Change your password" to everyone else.
        data["email"] = target_user.email
        data["has_usable_password"] = target_user.has_usable_password()
    return data


ONLINE_WINDOW = timedelta(minutes=5)


def _is_online(profile: Profile) -> bool:
    return bool(profile.last_seen_at and timezone.now() - profile.last_seen_at < ONLINE_WINDOW)


DISCOVER_ALLOWED_ORDERING = ["created_at", "-created_at", "username", "-username"]


def list_discoverable_profiles(viewer, *, role: str | None, query: str, ordering: str | None, page_size):
    qs = User.objects.select_related("profile", "privacy").filter(status=AccountStatus.ACTIVE)

    if role:
        qs = qs.filter(role=role)

    if viewer and viewer.is_authenticated:
        qs = qs.exclude(id=viewer.id)
        blocked_ids = Block.objects.filter(
            Q(blocker=viewer) | Q(blocked=viewer)
        ).values_list("blocker_id", "blocked_id")
        exclude_ids = {uid for pair in blocked_ids for uid in pair} - {viewer.id}
        if exclude_ids:
            qs = qs.exclude(id__in=exclude_ids)
        qs = qs.exclude(privacy__profile_visibility=ProfileVisibility.PRIVATE)
    else:
        qs = qs.filter(privacy__profile_visibility=ProfileVisibility.PUBLIC)

    query = (query or "").strip()[:100]  # bound search input length
    if query:
        qs = qs.filter(Q(username__icontains=query) | Q(profile__display_name__icontains=query))

    order = whitelist_ordering(ordering, DISCOVER_ALLOWED_ORDERING, default="-created_at")
    qs = qs.order_by(order)

    return qs, clamp_page_size(page_size)


# --- Blocking --------------------------------------------------------------------

def block_user(blocker: User, *, target_user_id) -> Block:
    if str(blocker.id) == str(target_user_id):
        raise DomainError("You cannot block yourself.")
    try:
        target = User.objects.get(id=target_user_id)
    except User.DoesNotExist as exc:
        raise DomainError("User not found.") from exc

    block, _ = Block.objects.get_or_create(blocker=blocker, blocked=target)
    return block


def unblock_user(blocker: User, *, target_user_id) -> None:
    Block.objects.filter(blocker=blocker, blocked_id=target_user_id).delete()


def list_blocks(user: User):
    return Block.objects.filter(blocker=user).select_related("blocked").order_by("-created_at")


# --- Account moderation (Phase 8) -----------------------------------------------
#
# Called from apps.moderation's views, not exposed directly under
# /api/accounts/ -- kept here (rather than duplicated in the
# moderation app) since AccountStatus and the User model itself live
# in this app, matching the pattern already established for
# suspend_service living in apps.services.services rather than
# apps.moderation.

def _is_staff(user) -> bool:
    return bool(user.is_staff or user.role in (AccountRole.MODERATOR, AccountRole.ADMIN))


@transaction.atomic
def suspend_account(staff_user, target_user_id, *, reason: str) -> User:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can suspend an account.")
    if not reason.strip():
        raise DomainError("A reason is required to suspend an account.")

    try:
        target = User.objects.select_for_update().get(id=target_user_id)
    except User.DoesNotExist as exc:
        raise DomainError("User not found.") from exc

    target.status = AccountStatus.SUSPENDED
    target.save(update_fields=["status", "updated_at"])
    _revoke_all_sessions(target)  # immediately kick out any active sessions
    AuditLog.objects.create(actor=staff_user, action=AuditAction.ACCOUNT_SUSPENDED, target_user=target, reason=reason)
    return target


@transaction.atomic
def ban_account(staff_user, target_user_id, *, reason: str) -> User:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can ban an account.")
    if not reason.strip():
        raise DomainError("A reason is required to ban an account.")

    try:
        target = User.objects.select_for_update().get(id=target_user_id)
    except User.DoesNotExist as exc:
        raise DomainError("User not found.") from exc

    target.status = AccountStatus.BANNED
    target.save(update_fields=["status", "updated_at"])
    _revoke_all_sessions(target)
    AuditLog.objects.create(actor=staff_user, action=AuditAction.ACCOUNT_BANNED, target_user=target, reason=reason)
    return target


@transaction.atomic
def reinstate_account(staff_user, target_user_id, *, reason: str = "") -> User:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can reinstate an account.")

    try:
        target = User.objects.select_for_update().get(id=target_user_id)
    except User.DoesNotExist as exc:
        raise DomainError("User not found.") from exc

    if target.status not in (AccountStatus.SUSPENDED, AccountStatus.BANNED):
        raise DomainError("This account is not currently suspended or banned.")

    target.status = AccountStatus.ACTIVE
    target.save(update_fields=["status", "updated_at"])
    AuditLog.objects.create(actor=staff_user, action=AuditAction.ACCOUNT_REINSTATED, target_user=target, reason=reason)
    return target


# --- Google sign-in ---------------------------------------------------------------

# =====================================================================
# Replace everything from "# --- Google sign-in ---" to the END of
# apps/accounts/services.py with this block.
#
# Also update these imports at the top of services.py:
#   import re
#   from django.db import IntegrityError, transaction
#   from google.auth.exceptions import GoogleAuthError
# =====================================================================

# --- Google sign-in ---------------------------------------------------------------

def _verify_google_token(raw_token: str) -> dict:
    """Verify a Google ID token server-side. Returns the verified claims.
    Everything we trust (email, name) must come from here, never from
    the request body."""
    if not settings.GOOGLE_CLIENT_ID:
        raise DomainError("Google sign-in is not configured.")
    try:
        idinfo = google_id_token.verify_oauth2_token(
            raw_token,
            google_requests.Request(),
            settings.GOOGLE_CLIENT_ID,
            clock_skew_in_seconds=10,
        )
    except (ValueError, GoogleAuthError) as exc:
        raise ValidationError({"id_token": ["Invalid Google token."]}) from exc

    email = idinfo.get("email")
    if not email or not idinfo.get("email_verified", False):
        raise ValidationError({"id_token": ["Google email missing or unverified."]})

    idinfo["email"] = User.objects.normalize_email(email).lower()
    return idinfo


def _google_full_name(idinfo: dict) -> str:
    parts = [idinfo.get("given_name", ""), idinfo.get("family_name", "")]
    return " ".join(p for p in parts if p).strip() or idinfo.get("name", "")


def _suggest_username(email: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.]", "", email.split("@")[0])[:25] or "user"
    username, suffix = base, 1
    while User.objects.filter(username__iexact=username).exists():
        username = f"{base}{suffix}"
        suffix += 1
    return username


def authenticate_google_login(request, id_token: str) -> dict:
    """LOGIN ONLY. Never creates an account.

    Returns one of:
      {"needs_signup": False, "user": user}   -- existing account, now logged in
      {"needs_signup": True, "email": ..., "name": ..., "suggested_username": ...}
                                              -- no account yet; nobody is logged in
    """
    idinfo = _verify_google_token(id_token)
    email = idinfo["email"]

    try:
        user = User.objects.get(email=email)
    except User.DoesNotExist:
        return {
            "needs_signup": True,
            "email": email,
            "name": _google_full_name(idinfo),
            "suggested_username": _suggest_username(email),
        }

    # Google just proved ownership of this email. If the existing account
    # was never verified, anyone could have pre-registered it with a
    # password they chose, so drop that password before trusting the login.
    if not user.email_verified:
        user.set_unusable_password()
        user.save(update_fields=["password"])
        user.mark_email_verified()
        user.refresh_from_db()

    _check_account_usable(user)
    _finish_login(request, user)
    return {"needs_signup": False, "user": user}


@transaction.atomic
def register_google_user(request, *, id_token: str, username: str, role: str = AccountRole.CUSTOMER) -> User:
    """Create an account from a Google identity, then log it in.

    The Google token is verified AGAIN here: the email comes from the
    token, never from the client, so nobody can register someone else's
    address by editing the request."""
    idinfo = _verify_google_token(id_token)
    email = idinfo["email"]

    if User.objects.filter(email=email).exists():
        raise ValidationError({"id_token": ["An account with this email already exists. Please log in."]})
    if User.objects.filter(username__iexact=username).exists():
        raise ValidationError({"username": ["This username is already taken."]})

    try:
        with transaction.atomic():  # savepoint, so a race doesn't poison the outer transaction
            user = User.objects.create_user(
                email=email,
                username=username,
                password=None,  # Google-only; they can set a password via reset later
                role=role,
                email_verified=True,  # Google already verified the address
                status=AccountStatus.ACTIVE,
            )
    except IntegrityError as exc:
        raise ValidationError({"username": ["This username or email is already taken."]}) from exc

    profile, _ = Profile.objects.get_or_create(user=user)
    ProfilePrivacy.objects.get_or_create(user=user)
    full_name = _google_full_name(idinfo)
    if full_name and not profile.display_name:
        profile.display_name = full_name[:50]  # matches max_length=50
        profile.save(update_fields=["display_name"])

    _finish_login(request, user)
    return user