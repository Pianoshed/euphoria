import logging
import uuid
import time
from datetime import timedelta

from decimal import Decimal

from django import forms
from django.contrib import admin, messages
from django.contrib.admin.utils import unquote
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import F as models_F, ProtectedError
from django.http import Http404, HttpResponseNotAllowed, HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone

from . import services
from .models import Block, EmailVerificationToken, PasswordResetToken, Profile, ProfilePrivacy, User, UserSession

logger = logging.getLogger("apps")

# Bulk "send verification email" limits. The mail provider rate-limits (Resend: ~2 requests/second)
# and a web request that runs too long gets killed, so each run handles a small batch.
# Run the action again for the rest.
VERIFY_MAX_PER_RUN = 20
VERIFY_DELAY_SECONDS = 0.5
# Don't re-send to someone who was emailed a link this recently (stops double-clicks / spamming).
VERIFY_MIN_GAP = timedelta(minutes=10)


class BulkPromoCreditForm(forms.Form):
    """Asked once, then applied to every selected user."""
    amount = forms.DecimalField(label="Amount per user (₦)", min_value=Decimal("0.01"), max_digits=12, decimal_places=2)
    source = forms.CharField(
        label="Reason / name", max_length=80, initial="Promotion",
        help_text="Shown to each person, e.g. 'Welcome gift' or 'Apology credit'.",
    )
    expires_in_days = forms.IntegerField(
        required=False, min_value=1, max_value=3650, label="Expires after (days)",
        help_text="Leave empty for no expiry.",
    )


def _money_blockers(user):
    """Reasons this account must not be hard-deleted (it has real-money or booking history)."""
    from apps.bookings.models import Booking
    from apps.economy.models import GiftTransaction, PlannerEarning, TransactionOrder
    from apps.wallet.models import LedgerEntry, PaymentIntent, Wallet, WithdrawalRequest
    from apps.common.constants import LedgerEntryType

    reasons = []
    if user.is_staff or user.is_superuser:
        reasons.append("staff/superuser account")
    if PaymentIntent.objects.filter(user=user).exists():
        reasons.append("has payments")
    if WithdrawalRequest.objects.filter(user=user).exists():
        reasons.append("has withdrawals")
    if Booking.objects.filter(customer=user).exists() or Booking.objects.filter(provider=user).exists():
        reasons.append("has bookings")
    if TransactionOrder.objects.filter(buyer=user).exists() or TransactionOrder.objects.filter(planner=user).exists():
        reasons.append("has orders")
    if PlannerEarning.objects.filter(planner=user).exists():
        reasons.append("has earnings")
    if GiftTransaction.objects.filter(sender=user).exists() or GiftTransaction.objects.filter(recipient=user).exists():
        reasons.append("has gifts")
    wallet = Wallet.objects.filter(user=user).first()
    if wallet is not None:
        if wallet.balance:
            reasons.append("wallet has a balance")
        promo_types = [LedgerEntryType.PROMOTIONAL_CREDIT, LedgerEntryType.PROMOTIONAL_DEBIT]
        if LedgerEntry.objects.filter(wallet=wallet).exclude(entry_type__in=promo_types).exists():
            reasons.append("has wallet transactions")
    return reasons


def _purge_and_delete_user(user):
    """Remove the user's promo-only records and chat rows that PROTECT the user row, then the user."""
    from apps.chat.models import CallLog, GroupCall, Message
    from apps.wallet.models import LedgerEntry, PromoCode, PromoRedemption, PromotionalCredit, Wallet

    with transaction.atomic():
        for red in PromoRedemption.objects.filter(user=user).select_related("promo_code"):
            PromoCode.objects.filter(pk=red.promo_code_id, redeemed_count__gt=0).update(
                redeemed_count=models_F("redeemed_count") - 1
            )
        PromoRedemption.objects.filter(user=user).delete()
        wallet = Wallet.objects.filter(user=user).first()
        if wallet is not None:
            LedgerEntry.objects.filter(wallet=wallet).delete()  # promo-only, checked by _money_blockers
        PromotionalCredit.objects.filter(user=user).delete()
        Message.objects.filter(sender=user).delete()
        CallLog.objects.filter(caller=user).delete()
        CallLog.objects.filter(callee=user).delete()
        GroupCall.objects.filter(started_by=user).delete()
        user.delete()


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    ordering = ["-created_at"]
    list_display = ["username", "email", "email_verified", "role", "status", "is_staff", "created_at"]
    list_filter = ["role", "status", "is_staff", "email_verified"]
    actions = ["send_verification_email_action", "give_promo_credit_action", "delete_users_action"]
    search_fields = ["username", "email"]
    readonly_fields = ["id", "created_at", "updated_at", "last_login", "last_login_ip"]

    fieldsets = (
        (None, {"fields": ("email", "username", "password")}),
        ("Role & status", {"fields": ("role", "status")}),
        (
            "Verification",
            {"fields": ("email_verified", "phone_verified", "identity_verification_status")},
        ),
        ("Security", {"fields": ("two_factor_enabled", "last_login_ip")}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Timestamps", {"fields": ("created_at", "updated_at", "last_login")}),
    )
    add_fieldsets = (
        (None, {"classes": ("wide",), "fields": ("email", "username", "password1", "password2")}),
    )

    # --- "Send verification email" button on a single user's page -----------------------------
    # The button itself lives in templates/admin/accounts/user/change_form.html (a POST form).

    def get_urls(self):
        custom = [
            path(
                "<path:object_id>/send-verification-email/",
                self.admin_site.admin_view(self.send_verification_email_view),
                name="accounts_user_send_verification",
            ),
        ]
        # Ours first: Django's catch-all "<id>/" route would otherwise swallow it.
        return custom + super().get_urls()

    def send_verification_email_view(self, request, object_id):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        user = self.get_object(request, unquote(object_id))
        if user is None:
            raise Http404("User not found.")
        if not self.has_change_permission(request, user):
            raise PermissionDenied

        back = HttpResponseRedirect(reverse("admin:accounts_user_change", args=[user.pk]))

        if user.email_verified:
            self.message_user(request, "This user has already verified their email.", messages.INFO)
            return back
        if not user.is_active:
            self.message_user(request, "This account is inactive, so no email was sent.", messages.WARNING)
            return back
        recent_cutoff = timezone.now() - VERIFY_MIN_GAP
        if user.email_verification_tokens.filter(created_at__gte=recent_cutoff).exists():
            minutes = int(VERIFY_MIN_GAP.total_seconds() // 60)
            self.message_user(
                request,
                f"A verification link was already sent in the last {minutes} minutes. Try again a little later.",
                messages.WARNING,
            )
            return back

        try:
            services._issue_email_verification_token(user)
        except Exception:
            logger.error("Admin verification email failed for user %s", user.pk, exc_info=True)
            self.message_user(request, "The email could not be sent. Check the server log.", messages.ERROR)
        else:
            self.message_user(request, f"Verification email sent to {user.email}.", messages.SUCCESS)
        return back

    @admin.action(
        description="Send verification email to selected unverified users",
        permissions=["change"],
    )
    def send_verification_email_action(self, request, queryset):
        """Emails a fresh verification link to every selected user who hasn't verified yet.

        Tip: filter the list by "Email verified: No", tick the "select all" box, run this action,
        and repeat until it reports nothing left to send.
        """
        unverified = queryset.filter(email_verified=False, is_active=True)
        already_verified = queryset.count() - unverified.count()

        # Anyone emailed a link a moment ago is left out BEFORE the batch is cut, so running the
        # action again moves on to the next people instead of hitting the same ones.
        recent_cutoff = timezone.now() - VERIFY_MIN_GAP
        recently_emailed = unverified.filter(email_verification_tokens__created_at__gte=recent_cutoff)
        too_recent = recently_emailed.distinct().count()
        to_send = unverified.exclude(pk__in=recently_emailed.values("pk"))

        batch = list(to_send.order_by("created_at")[:VERIFY_MAX_PER_RUN])
        left_for_next_run = to_send.count() - len(batch)

        sent = failed = 0
        for user in batch:
            try:
                services._issue_email_verification_token(user)
                sent += 1
            except Exception:
                failed += 1
                logger.error("Admin verification email failed for user %s", user.pk, exc_info=True)
            time.sleep(VERIFY_DELAY_SECONDS)

        if sent:
            self.message_user(request, f"Verification email sent to {sent} user(s).", messages.SUCCESS)
        if too_recent:
            minutes = int(VERIFY_MIN_GAP.total_seconds() // 60)
            self.message_user(
                request,
                f"{too_recent} user(s) skipped: they were already sent a link in the last {minutes} minutes.",
                messages.WARNING,
            )
        if already_verified:
            self.message_user(request, f"{already_verified} selected user(s) skipped: already verified or inactive.", messages.INFO)
        if left_for_next_run > 0:
            self.message_user(
                request,
                f"{left_for_next_run} more unverified user(s) not processed (limit {VERIFY_MAX_PER_RUN} per run). Run the action again.",
                messages.WARNING,
            )
        if failed:
            self.message_user(request, f"{failed} email(s) failed to send. Check the server log.", messages.ERROR)
        if not (sent or too_recent or already_verified or left_for_next_run or failed):
            self.message_user(request, "No unverified users in the selection.", messages.INFO)


    def get_actions(self, request):
        actions = super().get_actions(request)
        # Django's stock bulk delete just errors out on these accounts (their history is protected);
        # "delete_users_action" below replaces it.
        actions.pop("delete_selected", None)
        return actions

    @admin.action(description="Give promotional credit to selected users", permissions=["change"])
    def give_promo_credit_action(self, request, queryset):
        from apps.wallet import services as wallet_services

        form = BulkPromoCreditForm(request.POST if "apply" in request.POST else None)
        if "apply" in request.POST and form.is_valid():
            days = form.cleaned_data["expires_in_days"]
            expires_at = timezone.now() + timedelta(days=days) if days else None
            batch_id = str(uuid.uuid4())
            ok = failed = 0
            for user in queryset.filter(is_active=True):
                try:
                    wallet_services.grant_promotional_credit(
                        user, amount=form.cleaned_data["amount"], expires_at=expires_at,
                        source=form.cleaned_data["source"][:80],
                        metadata={"granted_by": str(request.user.id), "via": "admin-bulk", "batch": batch_id},
                    )
                    ok += 1
                except Exception:
                    failed += 1
                    logger.error("Bulk promo credit failed for user %s", user.pk, exc_info=True)
            skipped = queryset.count() - ok - failed
            if ok:
                self.message_user(
                    request, f"₦{form.cleaned_data['amount']} promotional credit given to {ok} user(s).", messages.SUCCESS
                )
            if skipped:
                self.message_user(request, f"{skipped} inactive user(s) skipped.", messages.INFO)
            if failed:
                self.message_user(request, f"{failed} grant(s) failed. Check the server log.", messages.ERROR)
            return None  # back to the list

        context = {
            **self.admin_site.each_context(request),
            "title": "Give promotional credit",
            "form": form,
            "users": queryset,
            "action_name": "give_promo_credit_action",
            "opts": self.model._meta,
            "action_checkbox_name": admin.helpers.ACTION_CHECKBOX_NAME,
        }
        return TemplateResponse(request, "admin/accounts/user/give_credit.html", context)

    @admin.action(description="Delete selected users (accounts with no payments/bookings only)", permissions=["delete"])
    def delete_users_action(self, request, queryset):
        users = list(queryset)
        deletable, blocked = [], []
        for user in users:
            reasons = _money_blockers(user)
            if user.pk == request.user.pk:
                reasons.insert(0, "this is you")
            (blocked if reasons else deletable).append((user, reasons))

        if "apply" in request.POST:
            deleted = 0
            for user, _ in deletable:
                try:
                    _purge_and_delete_user(user)
                    deleted += 1
                except ProtectedError:
                    blocked.append((user, ["still referenced by protected records"]))
                    logger.error("Admin delete blocked for user %s", user.pk, exc_info=True)
            if deleted:
                self.message_user(request, f"Deleted {deleted} user(s).", messages.SUCCESS)
            for user, reasons in blocked:
                self.message_user(request, f"Not deleted: {user.username} ({', '.join(reasons)}).", messages.WARNING)
            return None

        context = {
            **self.admin_site.each_context(request),
            "title": "Delete users",
            "deletable": [u for u, _ in deletable],
            "blocked": blocked,
            "users": queryset,
            "action_name": "delete_users_action",
            "opts": self.model._meta,
            "action_checkbox_name": admin.helpers.ACTION_CHECKBOX_NAME,
        }
        return TemplateResponse(request, "admin/accounts/user/delete_users.html", context)


class ReadOnlyAdminMixin:
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(UserSession)
class UserSessionAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["user", "ip_address", "created_at", "last_seen_at", "revoked_at"]
    list_filter = ["revoked_at"]
    search_fields = ["user__username", "user__email", "ip_address"]
    readonly_fields = [f.name for f in UserSession._meta.fields]


@admin.register(EmailVerificationToken)
class EmailVerificationTokenAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["user", "expires_at", "used_at", "created_at"]
    search_fields = ["user__username", "user__email"]
    readonly_fields = [f.name for f in EmailVerificationToken._meta.fields]


@admin.register(PasswordResetToken)
class PasswordResetTokenAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["user", "expires_at", "used_at", "created_at"]
    search_fields = ["user__username", "user__email"]
    readonly_fields = [f.name for f in PasswordResetToken._meta.fields]


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ["user", "display_name", "general_location", "age_range", "last_seen_at"]
    list_filter = ["age_range", "sex"]
    search_fields = ["user__username", "display_name"]
    readonly_fields = ["created_at", "updated_at"]


@admin.register(ProfilePrivacy)
class ProfilePrivacyAdmin(admin.ModelAdmin):
    list_display = ["user", "profile_visibility", "who_can_message", "who_can_send_service_requests"]
    list_filter = ["profile_visibility"]
    readonly_fields = ["created_at", "updated_at"]


@admin.register(Block)
class BlockAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ["blocker", "blocked", "created_at"]
    search_fields = ["blocker__username", "blocked__username"]
    readonly_fields = [f.name for f in Block._meta.fields]