import uuid

from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin
from django.db import models
from django.utils import timezone

from apps.common.constants import (
    AccountRole,
    AccountStatus,
    AgeRange,
    ContactPermission,
    ProfileVisibility,
    Sex,
    VerificationStatus,
    age_range_for_age,
)
from apps.common.validators import validate_username

from .managers import UserManager


class User(AbstractBaseUser, PermissionsMixin):
    """
    Custom user model for the platform.

    Design notes:
    - UUID primary key: internal sequential IDs are never exposed via
      the API, closing off simple account-enumeration attacks.
    - `role` is a coarse platform role (customer/provider/staff);
      fine-grained authorization still happens per-object in the
      service layer, never inferred from role alone.
    - `status` gates whether the account may act at all, independent
      of `role` and independent of `is_active` (which Django's own
      auth backend uses to block login entirely).
    - Verification state is tracked separately from the public profile
      (see apps.accounts.models.IdentityVerification) so verification
      artifacts are never accidentally serialized to other users.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    email = models.EmailField(unique=True, db_index=True)
    username = models.CharField(
        max_length=30, unique=True, db_index=True, validators=[validate_username]
    )

    role = models.CharField(
        max_length=20, choices=AccountRole.choices, default=AccountRole.CUSTOMER
    )
    status = models.CharField(
        max_length=25,
        choices=AccountStatus.choices,
        default=AccountStatus.PENDING_VERIFICATION,
    )

    # False only for accounts auto-created via Google sign-in that
    # haven't picked CUSTOMER vs PROVIDER yet (see
    # accounts.services.authenticate_google_login /
    # complete_onboarding). Password registration sets a role at
    # creation time via RegisterSerializer, so it defaults to True.
    role_confirmed = models.BooleanField(default=True)

    email_verified = models.BooleanField(default=False)
    email_verified_at = models.DateTimeField(null=True, blank=True)

    phone_number = models.CharField(max_length=20, blank=True)
    phone_verified = models.BooleanField(default=False)

    identity_verification_status = models.CharField(
        max_length=20,
        choices=VerificationStatus.choices,
        default=VerificationStatus.UNVERIFIED,
    )

    two_factor_enabled = models.BooleanField(default=False)
    # Base32 TOTP secret. Only meaningful once two_factor_enabled=True;
    # a secret may exist here mid-setup (enabled=False) without being
    # usable, since login only checks the secret when enabled=True.
    # NOTE: in production this column should use field-level encryption
    # (e.g. via a KMS-backed encrypted field) -- flagged for the
    # security-hardening phase, not solved here.
    two_factor_secret = models.CharField(max_length=64, blank=True)

    # Django auth plumbing -- distinct from `status` above.
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)

    last_login_ip = models.GenericIPAddressField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["username"]

    class Meta:
        db_table = "accounts_user"
        indexes = [
            models.Index(fields=["status"]),
            models.Index(fields=["role"]),
        ]

    def __str__(self):
        return self.username

    @property
    def is_platform_active(self) -> bool:
        """Whether the account may perform normal platform actions.
        Distinct from Django's `is_active`, which only gates login."""
        return self.status == AccountStatus.ACTIVE

    def mark_email_verified(self):
        self.email_verified = True
        self.email_verified_at = timezone.now()
        if self.status == AccountStatus.PENDING_VERIFICATION:
            self.status = AccountStatus.ACTIVE
        self.save(update_fields=["email_verified", "email_verified_at", "status", "updated_at"])


class EmailVerificationToken(models.Model):
    """Single-use, expiring, hash-stored token for confirming an email
    address. See apps.accounts.tokens for why we store a hash, not the
    raw token."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="email_verification_tokens")
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_email_verification_token"

    @property
    def is_valid(self) -> bool:
        return self.used_at is None and self.expires_at > timezone.now()


class PasswordResetToken(models.Model):
    """Single-use, expiring, hash-stored token for resetting a
    forgotten password."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="password_reset_tokens")
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_password_reset_token"

    @property
    def is_valid(self) -> bool:
        return self.used_at is None and self.expires_at > timezone.now()


class UserSession(models.Model):
    """Tracks Django sessions per-user so a user (or an admin) can see
    and individually revoke active sessions/devices. This is metadata
    only -- the actual session data/auth state lives in Django's own
    session store; revoking here must also purge the matching Django
    session (see accounts.services.revoke_session)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sessions")
    session_key = models.CharField(max_length=40, unique=True, db_index=True)
    user_agent = models.CharField(max_length=255, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "accounts_user_session"
        indexes = [models.Index(fields=["user", "revoked_at"])]

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None


def avatar_upload_path(instance, filename):
    # Never trust the client-supplied filename or extension -- the
    # actual extension is chosen server-side after verifying the real
    # file signature (see apps.accounts.media_utils).
    return f"avatars/{instance.user_id}/{uuid.uuid4().hex}.jpg"


class Profile(models.Model):
    """Public-facing profile, separate from User so account/auth
    fields are never accidentally serialized alongside profile data.

    latitude/longitude are stored for future distance-based search but
    are NEVER included in any serializer exposed to other users --
    only `general_location` (free text, user-controlled precision) is
    public. See apps.accounts.serializers.
    """

    user = models.OneToOneField(User, on_delete=models.CASCADE, primary_key=True, related_name="profile")

    display_name = models.CharField(max_length=50, blank=True)
    bio = models.TextField(max_length=1000, blank=True)
    avatar = models.ImageField(upload_to=avatar_upload_path, null=True, blank=True)

    general_location = models.CharField(max_length=100, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)

    availability = models.CharField(max_length=200, blank=True)
    preferences = models.JSONField(default=dict, blank=True)

    last_seen_at = models.DateTimeField(null=True, blank=True)

    # Demographics collected at sign-up. Data minimisation: only the band is
    # public (age_range -> glow colour). birth_year is optional, owner-only, and
    # when present it wins so the band moves on as the person gets older.
    # `sex` is owner/staff-only and is never part of any other user's view.
    age_range = models.CharField(max_length=12, choices=AgeRange.choices, blank=True)
    birth_year = models.PositiveSmallIntegerField(null=True, blank=True)
    sex = models.CharField(max_length=12, choices=Sex.choices, default=Sex.UNDISCLOSED)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "accounts_profile"

    def __str__(self):
        return self.display_name or self.user.username

    @property
    def effective_display_name(self) -> str:
        return self.display_name or self.user.username

    @property
    def effective_age_range(self) -> str:
        """The band other people see. Derived from birth_year when we have it
        (approximate: year difference, no birthday), else the stored band.
        Empty string for older accounts that never answered."""
        if self.birth_year:
            return age_range_for_age(timezone.now().year - self.birth_year)
        return self.age_range


class ProfilePrivacy(models.Model):
    """Per-user privacy controls. Kept as its own table (not fields on
    Profile) so it's trivial to lock down independently and to extend
    without touching the public-profile table."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, primary_key=True, related_name="privacy")

    profile_visibility = models.CharField(
        max_length=20, choices=ProfileVisibility.choices, default=ProfileVisibility.REGISTERED_USERS
    )
    show_online_status = models.BooleanField(default=False)
    show_last_seen = models.BooleanField(default=False)
    who_can_message = models.CharField(
        max_length=10, choices=ContactPermission.choices, default=ContactPermission.EVERYONE
    )
    who_can_send_service_requests = models.CharField(
        max_length=10, choices=ContactPermission.choices, default=ContactPermission.EVERYONE
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "accounts_profile_privacy"


class Block(models.Model):
    """One-directional block: `blocker` no longer sees `blocked` (and
    vice versa, for profile visibility/discovery -- later phases such
    as chat and bookings must also consult this before allowing any
    interaction between the two users)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    blocker = models.ForeignKey(User, on_delete=models.CASCADE, related_name="blocks_made")
    blocked = models.ForeignKey(User, on_delete=models.CASCADE, related_name="blocked_by")
    reason = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "accounts_block"
        constraints = [
            models.UniqueConstraint(fields=["blocker", "blocked"], name="unique_block_pair"),
            models.CheckConstraint(condition=~models.Q(blocker=models.F("blocked")), name="block_not_self"),
        ]
        indexes = [models.Index(fields=["blocker", "blocked"])]