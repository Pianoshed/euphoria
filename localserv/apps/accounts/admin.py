import logging
import time
from datetime import timedelta

from django.contrib import admin, messages
from django.contrib.admin.utils import unquote
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.core.exceptions import PermissionDenied
from django.http import Http404, HttpResponseNotAllowed, HttpResponseRedirect
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


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    ordering = ["-created_at"]
    list_display = ["username", "email", "email_verified", "role", "status", "is_staff", "created_at"]
    list_filter = ["role", "status", "is_staff", "email_verified"]
    actions = ["send_verification_email_action"]
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