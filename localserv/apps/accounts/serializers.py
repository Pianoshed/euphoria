from rest_framework import serializers

from apps.common.constants import AccountRole, ContactPermission, ProfileVisibility

from .models import User, UserSession


class UserPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "role", "status", "email_verified", "two_factor_enabled", "created_at"]
        read_only_fields = fields


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    username = serializers.CharField(min_length=3, max_length=30)
    password = serializers.CharField(write_only=True, min_length=10)
    role = serializers.ChoiceField(
        choices=[AccountRole.CUSTOMER.value, AccountRole.PROVIDER.value],
        default=AccountRole.CUSTOMER.value,
        required=False,
    )

    def validate_email(self, value):
        return value.lower()


class EmailVerifySerializer(serializers.Serializer):
    token = serializers.CharField()


class ResendVerificationSerializer(serializers.Serializer):
    email = serializers.EmailField()


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)


class LoginMFASerializer(serializers.Serializer):
    challenge = serializers.CharField()
    code = serializers.CharField(max_length=10)


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, min_length=10)


class PasswordChangeSerializer(serializers.Serializer):
    old_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=10)


class UserSessionSerializer(serializers.ModelSerializer):
    is_current = serializers.SerializerMethodField()

    class Meta:
        model = UserSession
        fields = ["id", "user_agent", "ip_address", "created_at", "last_seen_at", "is_current"]
        read_only_fields = fields

    def get_is_current(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and obj.session_key == request.session.session_key)


class TwoFactorConfirmSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=10)


class TwoFactorDisableSerializer(serializers.Serializer):
    password = serializers.CharField(write_only=True)


class ProfileUpdateSerializer(serializers.Serializer):
    display_name = serializers.CharField(max_length=50, allow_blank=True, required=False)
    bio = serializers.CharField(max_length=1000, allow_blank=True, required=False)
    general_location = serializers.CharField(max_length=100, allow_blank=True, required=False)
    latitude = serializers.DecimalField(max_digits=9, decimal_places=6, required=False, allow_null=True)
    longitude = serializers.DecimalField(max_digits=9, decimal_places=6, required=False, allow_null=True)
    availability = serializers.CharField(max_length=200, allow_blank=True, required=False)
    preferences = serializers.JSONField(required=False)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("No updatable fields were provided.")
        return attrs


class ProfilePrivacyUpdateSerializer(serializers.Serializer):
    profile_visibility = serializers.ChoiceField(choices=ProfileVisibility.choices, required=False)
    show_online_status = serializers.BooleanField(required=False)
    show_last_seen = serializers.BooleanField(required=False)
    who_can_message = serializers.ChoiceField(choices=ContactPermission.choices, required=False)
    who_can_send_service_requests = serializers.ChoiceField(choices=ContactPermission.choices, required=False)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("No updatable fields were provided.")
        return attrs


class DiscoverQuerySerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=[r.value for r in AccountRole], required=False)
    q = serializers.CharField(required=False, allow_blank=True, max_length=100)
    ordering = serializers.CharField(required=False, allow_blank=True)
    page_size = serializers.IntegerField(required=False, min_value=1, max_value=100)


class BlockCreateSerializer(serializers.Serializer):
    user_id = serializers.UUIDField()


class BlockedUserSerializer(serializers.Serializer):
    id = serializers.UUIDField(source="blocked.id")
    username = serializers.CharField(source="blocked.username")
    reason = serializers.CharField()
    created_at = serializers.DateTimeField()


class GoogleLoginSerializer(serializers.Serializer):
    id_token = serializers.CharField()


class GoogleRegisterSerializer(serializers.Serializer):
    """Second step of Google signup. The email is deliberately NOT a field:
    the server takes it from the verified id_token."""

    id_token = serializers.CharField()
    username = serializers.CharField(min_length=3, max_length=30)
    # Same allowed roles as RegisterSerializer: never admin/moderator.
    role = serializers.ChoiceField(
        choices=[AccountRole.CUSTOMER.value, AccountRole.PROVIDER.value],
        default=AccountRole.CUSTOMER.value,
        required=False,
    )


class OnboardingCompleteSerializer(serializers.Serializer):
    role = serializers.ChoiceField(
        choices=[AccountRole.CUSTOMER.value, AccountRole.PROVIDER.value]
    )