import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError

from apps.accounts.models import User
from apps.common.constants import AccountStatus

pytestmark = pytest.mark.django_db


def test_create_user_normalizes_email_and_hashes_password():
    user = User.objects.create_user(
        email="Jane@Example.com", username="jane_doe", password="a-strong-password-1"
    )
    assert user.email == "jane@example.com"
    assert user.password != "a-strong-password-1"
    assert user.check_password("a-strong-password-1")


def test_new_user_starts_pending_verification():
    user = User.objects.create_user(
        email="new@example.com", username="newuser", password="a-strong-password-1"
    )
    assert user.status == AccountStatus.PENDING_VERIFICATION
    assert user.is_platform_active is False


def test_mark_email_verified_activates_account():
    user = User.objects.create_user(
        email="verify@example.com", username="verifyme", password="a-strong-password-1"
    )
    user.mark_email_verified()
    user.refresh_from_db()
    assert user.email_verified is True
    assert user.status == AccountStatus.ACTIVE
    assert user.is_platform_active is True


def test_duplicate_email_rejected():
    # The manager's full_clean() catches this at the validation layer
    # (ValidationError) before it would ever reach the DB unique
    # constraint (IntegrityError). Both layers exist deliberately --
    # see apps/common's note on never trusting app-level validation
    # alone for invariants that matter; the DB constraint is the
    # backstop for any write path that skips the manager.
    User.objects.create_user(
        email="dupe@example.com", username="dupeuser1", password="a-strong-password-1"
    )
    with pytest.raises(ValidationError):
        User.objects.create_user(
            email="dupe@example.com", username="dupeuser2", password="a-strong-password-1"
        )


def test_duplicate_email_rejected_at_db_layer_too():
    # Bypass the manager's full_clean() to prove the DB-level unique
    # constraint is a real backstop, not just app-level validation.
    User.objects.create_user(
        email="dupe2@example.com", username="dupeuser3", password="a-strong-password-1"
    )
    with pytest.raises(IntegrityError):
        User.objects.create(
            email="dupe2@example.com", username="dupeuser4", password="x"
        )


def test_invalid_username_rejected():
    with pytest.raises(ValidationError):
        User.objects.create_user(
            email="bad@example.com", username="a", password="a-strong-password-1"
        )
