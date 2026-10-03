from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import Block, EmailVerificationToken, PasswordResetToken, Profile, ProfilePrivacy, User, UserSession


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    ordering = ["-created_at"]
    list_display = ["username", "email", "role", "status", "is_staff", "created_at"]
    list_filter = ["role", "status", "is_staff", "email_verified"]
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
    list_display = ["user", "display_name", "general_location", "last_seen_at"]
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
