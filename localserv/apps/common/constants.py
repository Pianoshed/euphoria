from django.db import models


class AccountRole(models.TextChoices):
    CUSTOMER = "CUSTOMER", "Customer"
    PROVIDER = "PROVIDER", "Provider"
    MODERATOR = "MODERATOR", "Moderator"
    ADMIN = "ADMIN", "Admin"


class AccountStatus(models.TextChoices):
    ACTIVE = "ACTIVE", "Active"
    SUSPENDED = "SUSPENDED", "Suspended"
    DEACTIVATED = "DEACTIVATED", "Deactivated"
    BANNED = "BANNED", "Banned"
    PENDING_VERIFICATION = "PENDING_VERIFICATION", "Pending verification"


class AgeRange(models.TextChoices):
    """Age bands shown to other people as a coloured glow around a profile bubble.
    Only the band is ever public -- never a birth year or exact age.
    NOTE: the brief listed \"40-60\", which leaves 36-39 uncovered; the band is 36-60 here."""

    UNDER_16 = "UNDER_16", "Under 16"
    AGE_16_25 = "AGE_16_25", "16-25"
    AGE_26_35 = "AGE_26_35", "26-35"
    AGE_36_60 = "AGE_36_60", "36-60"
    OVER_60 = "OVER_60", "Over 60"


class Sex(models.TextChoices):
    """Private to the account owner (and staff). Never returned to other users."""

    MALE = "M", "Male"
    FEMALE = "F", "Female"
    PREFER_NOT_TO_SAY = "PNS", "Prefer not to say"
    UNDISCLOSED = "UNDISCLOSED", "Undisclosed"  # question skipped / not asked (e.g. accounts that predate it)


def age_range_for_age(age: int) -> str:
    if age < 16:
        return AgeRange.UNDER_16
    if age <= 25:
        return AgeRange.AGE_16_25
    if age <= 35:
        return AgeRange.AGE_26_35
    if age <= 60:
        return AgeRange.AGE_36_60
    return AgeRange.OVER_60


class VerificationStatus(models.TextChoices):
    UNVERIFIED = "UNVERIFIED", "Unverified"
    PENDING = "PENDING", "Pending review"
    VERIFIED = "VERIFIED", "Verified"
    REJECTED = "REJECTED", "Rejected"


class ProfileVisibility(models.TextChoices):
    PUBLIC = "PUBLIC", "Public"  # visible to anyone, including anonymous visitors
    REGISTERED_USERS = "REGISTERED_USERS", "Registered users only"
    PRIVATE = "PRIVATE", "Private"  # visible only to the owner (and staff)


class ContactPermission(models.TextChoices):
    EVERYONE = "EVERYONE", "Everyone"
    NOBODY = "NOBODY", "Nobody"


class ServiceStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    PUBLISHED = "PUBLISHED", "Published"
    ARCHIVED = "ARCHIVED", "Archived"  # owner-initiated, terminal-ish (can be re-drafted)
    SUSPENDED = "SUSPENDED", "Suspended"  # staff-only, e.g. moderation action


class BookingStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    ACCEPTED = "ACCEPTED", "Accepted"
    DECLINED = "DECLINED", "Declined"
    FUNDED = "FUNDED", "Funded"  # customer's payment is held in escrow
    IN_PROGRESS = "IN_PROGRESS", "In progress"
    COMPLETED = "COMPLETED", "Completed"
    RELEASED = "RELEASED", "Released"  # escrow paid out to the provider
    CANCELLED = "CANCELLED", "Cancelled"
    REFUNDED = "REFUNDED", "Refunded"  # escrow returned to the customer via dispute resolution
    DISPUTED = "DISPUTED", "Disputed"


class LedgerEntryType(models.TextChoices):
    TOKEN_DEPOSIT = "TOKEN_DEPOSIT", "Token deposit"
    ESCROW_HOLD = "ESCROW_HOLD", "Escrow hold"
    ESCROW_RELEASE = "ESCROW_RELEASE", "Escrow release"
    ESCROW_REFUND = "ESCROW_REFUND", "Escrow refund"
    ADMIN_ADJUSTMENT = "ADMIN_ADJUSTMENT", "Admin adjustment"
    PLAN_PAYMENT = "PLAN_PAYMENT", "Plan payment"
    PLAN_REFUND = "PLAN_REFUND", "Plan refund"
    PLANNER_EARNING = "PLANNER_EARNING", "Planner earning"
    PLATFORM_FEE = "PLATFORM_FEE", "Platform fee"
    EARNINGS_REVERSAL = "EARNINGS_REVERSAL", "Earnings reversal"
    GIFT_CREDIT = "GIFT_CREDIT", "Gift credit"
    GIFT_DEBIT = "GIFT_DEBIT", "Gift debit"
    PROMOTIONAL_CREDIT = "PROMOTIONAL_CREDIT", "Promotional credit"
    PROMOTIONAL_DEBIT = "PROMOTIONAL_DEBIT", "Promotional debit"
    WITHDRAWAL = "WITHDRAWAL", "Withdrawal"
    WITHDRAWAL_REVERSAL = "WITHDRAWAL_REVERSAL", "Withdrawal reversal"


class EscrowStatus(models.TextChoices):
    HELD = "HELD", "Held"
    RELEASED = "RELEASED", "Released"
    REFUNDED = "REFUNDED", "Refunded"


class PaymentIntentStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    SUCCEEDED = "SUCCEEDED", "Succeeded"
    FAILED = "FAILED", "Failed"


class WithdrawalStatus(models.TextChoices):
    REQUESTED = "REQUESTED", "Requested"
    PROCESSING = "PROCESSING", "Processing"
    COMPLETED = "COMPLETED", "Completed"
    FAILED = "FAILED", "Failed"
    REVERSED = "REVERSED", "Reversed"  # staff manually reversed a stuck/incorrect payout
