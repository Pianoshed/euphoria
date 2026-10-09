from django.contrib import admin

from .models import Escrow, LedgerEntry, PaymentIntent, PaymentWebhookEvent, PayoutAccount, PromotionalCredit, Wallet, WithdrawalRequest


class ReadOnlyAdminMixin:
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Wallet)
class WalletAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["user", "balance", "promotional_balance", "updated_at"]
    search_fields = ["user__username", "user__email"]
    readonly_fields = [f.name for f in Wallet._meta.fields]


@admin.register(LedgerEntry)
class LedgerEntryAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["wallet", "entry_type", "amount", "balance_after", "booking", "created_at"]
    list_filter = ["entry_type"]
    search_fields = ["wallet__user__username", "idempotency_key"]
    readonly_fields = [f.name for f in LedgerEntry._meta.fields]


@admin.register(Escrow)
class EscrowAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["booking", "amount", "status", "created_at", "released_at", "refunded_at"]
    list_filter = ["status"]
    readonly_fields = [f.name for f in Escrow._meta.fields]


@admin.register(PaymentIntent)
class PaymentIntentAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["id", "user", "amount", "provider", "status", "created_at"]
    list_filter = ["provider", "status"]
    search_fields = ["user__username", "provider_reference", "idempotency_key"]
    readonly_fields = [f.name for f in PaymentIntent._meta.fields]


@admin.register(PaymentWebhookEvent)
class PaymentWebhookEventAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["provider", "provider_event_id", "payment_intent", "processed_at"]
    search_fields = ["provider_event_id"]
    readonly_fields = [f.name for f in PaymentWebhookEvent._meta.fields]


@admin.register(PayoutAccount)
class PayoutAccountAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["user", "label", "masked_reference", "is_active", "created_at"]
    search_fields = ["user__username", "label", "masked_reference"]
    readonly_fields = [f.name for f in PayoutAccount._meta.fields]


@admin.register(WithdrawalRequest)
class WithdrawalRequestAdmin(admin.ModelAdmin):
    """Not fully read-only like the others -- staff need to be able to
    act on `status`/`failure_reason` for a withdrawal that requires
    manual review, matching Sec 15's async workflow. Everything else
    about the request itself (amount, user, idempotency_key) is
    immutable."""

    list_display = ["id", "user", "amount", "source", "status", "provider", "completed_at"]
    list_filter = ["status", "provider"]
    search_fields = ["user__username", "provider_reference", "idempotency_key"]
    readonly_fields = [
        "id", "user", "amount", "payout_account", "provider", "provider_reference",
        "idempotency_key", "reversed_by", "created_at", "updated_at",
    ]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(PromotionalCredit)
class PromotionalCreditAdmin(admin.ModelAdmin):
    list_display = ["user", "original_amount", "remaining_amount", "expires_at", "source", "created_at"]
    list_filter = ["source", "expires_at"]
    search_fields = ["user__username", "reference"]
    readonly_fields = ["user", "original_amount", "remaining_amount", "expires_at", "plan", "category", "source", "reference", "metadata", "created_at", "updated_at"]

    def has_add_permission(self, request):
        return False
