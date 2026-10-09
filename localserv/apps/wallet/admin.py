from django.contrib import admin

from datetime import timedelta

from django import forms
from django.utils import timezone

from .models import (
    Escrow, LedgerEntry, PaymentIntent, PaymentWebhookEvent, PayoutAccount, PromoCode, PromoRedemption,
    PromotionalCredit, Wallet, WithdrawalRequest,
)
from . import services


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


class GrantCreditForm(forms.ModelForm):
    """Add form for 'give this person platform credit'. Saving goes through services.grant_promotional_credit,
    so the credit, the wallet's promotional balance and the ledger entry are always written together."""
    expires_in_days = forms.IntegerField(required=False, min_value=1, max_value=3650, help_text="Leave empty for no expiry.")

    class Meta:
        model = PromotionalCredit
        fields = ["user", "original_amount", "source", "plan", "category"]
        labels = {"original_amount": "Amount (₦)", "source": "Reason / name"}
        help_texts = {"source": "Shown to the person, e.g. 'Welcome gift' or 'Apology credit'.",
                      "plan": "Optional: only usable on this plan.", "category": "Optional: only usable on plans in this category."}


@admin.register(PromotionalCredit)
class PromotionalCreditAdmin(admin.ModelAdmin):
    """Staff can GIVE credit here (use 'Add'). Existing grants are read-only: they are money records."""
    list_display = ["user", "original_amount", "remaining_amount", "expires_at", "source", "created_at"]
    list_filter = ["source", "expires_at"]
    search_fields = ["user__username", "reference"]
    autocomplete_fields = ["user"]
    _readonly = ["user", "original_amount", "remaining_amount", "expires_at", "plan", "category", "source", "reference", "metadata", "created_at", "updated_at"]

    def get_form(self, request, obj=None, **kwargs):
        if obj is None:
            kwargs["form"] = GrantCreditForm
            kwargs["fields"] = ["user", "original_amount", "source", "plan", "category", "expires_in_days"]
        return super().get_form(request, obj, **kwargs)

    def get_readonly_fields(self, request, obj=None):
        return self._readonly if obj is not None else []

    def has_change_permission(self, request, obj=None):
        return False  # grants are created (Add) and then only viewed

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        if change:
            return
        days = form.cleaned_data.get("expires_in_days")
        credit = services.grant_promotional_credit(
            form.cleaned_data["user"], amount=form.cleaned_data["original_amount"],
            expires_at=timezone.now() + timedelta(days=days) if days else None,
            plan=form.cleaned_data.get("plan"), category=form.cleaned_data.get("category"),
            source=(form.cleaned_data.get("source") or "PROMOTION")[:80],
            metadata={"granted_by": str(request.user.id), "via": "admin"},
        )
        for f in credit._meta.concrete_fields:  # let Django's "added" message/log see the saved row
            setattr(obj, f.attname, getattr(credit, f.attname))
        obj._state.adding = False


@admin.register(PromoCode)
class PromoCodeAdmin(admin.ModelAdmin):
    """Staff create and switch off promo codes here. People redeem them from the wallet page."""
    list_display = ["code", "name", "amount", "redeemed_count", "max_redemptions", "valid_until", "is_active", "created_at"]
    list_filter = ["is_active", "category"]
    search_fields = ["code", "name"]
    fields = ["code", "name", "amount", "max_redemptions", "starts_at", "valid_until", "credit_valid_days", "plan", "category", "is_active", "redeemed_count", "created_by"]
    readonly_fields = ["redeemed_count", "created_by"]

    def get_readonly_fields(self, request, obj=None):
        # amount/code are fixed once people may have seen the code
        return self.readonly_fields + (["code", "amount"] if obj else [])

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        if not change:
            obj.code = services.normalize_promo_code(obj.code) or services.generate_promo_code()
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(PromoRedemption)
class PromoRedemptionAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["promo_code", "user", "created_at"]
    search_fields = ["promo_code__code", "user__username"]
    readonly_fields = [f.name for f in PromoRedemption._meta.fields]
