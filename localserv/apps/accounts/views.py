from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common.throttles import LoginEmailThrottle, MfaChallengeThrottle, WriteRateThrottle

from . import services
from .models import User
from .serializers import (
    BlockCreateSerializer,
    BlockedUserSerializer,
    DiscoverQuerySerializer,
    EmailVerifySerializer,
    GoogleLoginSerializer,
    GoogleRegisterSerializer,
    LoginMFASerializer,
    LoginSerializer,
    OnboardingCompleteSerializer,
    PasswordChangeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    ProfilePrivacyUpdateSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    ResendVerificationSerializer,
    TwoFactorConfirmSerializer,
    TwoFactorDisableSerializer,
    UserPublicSerializer,
    UserSessionSerializer,
)


class CSRFBootstrapView(APIView):
    """GET /api/accounts/csrf/ -- sets the csrftoken cookie AND returns the
    token in the JSON body. The body is needed when the frontend and API
    are on different domains: JS can't read another domain's cookies, so
    it echoes this value back as the X-CSRFToken header on unsafe requests.
    Safe to call repeatedly; GET requests are never subject to CSRF checks.
    """

    permission_classes = [AllowAny]
    authentication_classes = []

    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return Response({"detail": "CSRF cookie set.", "csrfToken": get_token(request)})


class RegisterView(APIView):
    permission_classes = [AllowAny]
    # Skip session auth so a stale session can't trigger CSRF on signup.
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "registration"

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = services.register_user(**serializer.validated_data)
        return Response(UserPublicSerializer(user).data, status=status.HTTP_201_CREATED)


class VerifyEmailView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "email_verification"

    def post(self, request):
        serializer = EmailVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = services.verify_email(raw_token=serializer.validated_data["token"])
        return Response(UserPublicSerializer(user).data)


class ResendVerificationView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle, LoginEmailThrottle]
    throttle_scope = "email_verification"

    def post(self, request):
        serializer = ResendVerificationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.resend_verification_email(**serializer.validated_data)
        return Response({"detail": services.GENERIC_VERIFICATION_SENT})


class LoginView(APIView):
    # Session auth stays ON here, so CSRF is enforced for password login.
    # The frontend must send X-CSRFToken (see CSRFBootstrapView).
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle, LoginEmailThrottle]
    throttle_scope = "login"

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = services.authenticate_login(request, **serializer.validated_data)
        if "mfa_challenge" in result:
            return Response({"mfa_required": True, "challenge": result["mfa_challenge"]})
        return Response({"mfa_required": False, "user": UserPublicSerializer(result["user"]).data})


class LoginMFAView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle, MfaChallengeThrottle]
    throttle_scope = "two_factor"

    def post(self, request):
        serializer = LoginMFASerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = services.verify_login_mfa(request, **serializer.validated_data)
        return Response({"user": UserPublicSerializer(user).data})


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        services.logout_user(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PasswordResetRequestView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle, LoginEmailThrottle]
    throttle_scope = "password_reset"

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.request_password_reset(**serializer.validated_data)
        return Response({"detail": services.GENERIC_RESET_SENT})


class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_reset"

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.confirm_password_reset(
            raw_token=serializer.validated_data["token"],
            new_password=serializer.validated_data["new_password"],
        )
        return Response({"detail": "Password reset successfully. Please log in again."})


class PasswordChangeView(APIView):
    permission_classes = [IsAuthenticated]
    # Stops someone on a stolen/unattended session from guessing the current password.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_change"

    def post(self, request):
        serializer = PasswordChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.change_password(
            request.user,
            keep_session_key=request.session.session_key,
            **serializer.validated_data,
        )
        return Response({"detail": "Password changed successfully."})


class SessionListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        sessions = services.list_sessions(request.user)
        data = UserSessionSerializer(sessions, many=True, context={"request": request}).data
        return Response(data)


class SessionRevokeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, session_id):
        services.revoke_session(request.user, session_id=session_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SessionRevokeAllView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        services.revoke_all_sessions(request.user, keep_session_key=request.session.session_key)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TwoFactorSetupView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        data = services.start_2fa_setup(request.user)
        return Response(data)


class TwoFactorConfirmView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "two_factor"

    def post(self, request):
        serializer = TwoFactorConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.confirm_2fa_setup(request.user, **serializer.validated_data)
        return Response({"detail": "Two-factor authentication enabled."})


class TwoFactorDisableView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "two_factor"

    def post(self, request):
        serializer = TwoFactorDisableSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.disable_2fa(request.user, **serializer.validated_data)
        return Response({"detail": "Two-factor authentication disabled."})


# --- Profile -------------------------------------------------------------------

class MyProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        data = services.get_public_profile(request.user, request.user)
        return Response(data)

    def patch(self, request):
        serializer = ProfileUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        services.update_profile(request.user, **serializer.validated_data)
        return Response(services.get_public_profile(request.user, request.user))


class MyPrivacyView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        privacy = request.user.privacy
        return Response(ProfilePrivacyUpdateSerializer(privacy).data)

    def patch(self, request):
        serializer = ProfilePrivacyUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        privacy = services.update_privacy(request.user, **serializer.validated_data)
        return Response(ProfilePrivacyUpdateSerializer(privacy).data)


class AvatarUploadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        uploaded = request.FILES.get("avatar")
        if not uploaded:
            raise ValidationError({"avatar": ["No file provided."]})
        profile = services.upload_avatar(request.user, uploaded)
        return Response({"avatar": profile.avatar.url if profile.avatar else None})


class PublicProfileView(APIView):
    permission_classes = [AllowAny]

    def get(self, request, user_id):
        try:
            target = User.objects.select_related("profile", "privacy").get(id=user_id)
        except User.DoesNotExist as exc:
            raise NotFound("Profile not found.") from exc

        data = services.get_public_profile(
            request.user if request.user.is_authenticated else None, target
        )
        if data is None:
            raise NotFound("Profile not found.")
        return Response(data)


class DiscoverPagination(PageNumberPagination):
    page_size = 20
    max_page_size = 100


class DiscoverProfilesView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        query_serializer = DiscoverQuerySerializer(data=request.query_params)
        query_serializer.is_valid(raise_exception=True)
        params = query_serializer.validated_data

        qs, page_size = services.list_discoverable_profiles(
            request.user if request.user.is_authenticated else None,
            role=params.get("role"),
            query=params.get("q", ""),
            ordering=params.get("ordering"),
            page_size=params.get("page_size"),
        )

        paginator = DiscoverPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        results = [
            services.get_public_profile(request.user if request.user.is_authenticated else None, u)
            for u in page
        ]
        results = [r for r in results if r is not None]
        return paginator.get_paginated_response(results)


class PresencePingView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        services.touch_presence(request.user)
        return Response({"detail": "ok"})


# --- Blocking --------------------------------------------------------------------

class BlockListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        blocks = services.list_blocks(request.user)
        return Response(BlockedUserSerializer(blocks, many=True).data)

    def post(self, request):
        serializer = BlockCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.block_user(request.user, target_user_id=serializer.validated_data["user_id"])
        return Response(status=status.HTTP_201_CREATED)


class BlockDeleteView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, user_id):
        services.unblock_user(request.user, target_user_id=user_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


# --- Google sign-in --------------------------------------------------------------

class GoogleLoginView(APIView):
    """Login only. An unknown email is NOT logged in or created: the
    response tells the frontend to send the person to create-account."""

    permission_classes = [AllowAny]
    # The signed Google ID token is the proof of identity here, and a stale
    # session cookie must not cause a CSRF 403 on login.
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"

    def post(self, request):
        serializer = GoogleLoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = services.authenticate_google_login(request, **serializer.validated_data)
        if result["needs_signup"]:
            return Response({
                "needs_signup": True,
                "email": result["email"],
                "name": result["name"],
                "suggested_username": result["suggested_username"],
            })
        return Response({"needs_signup": False, "user": UserPublicSerializer(result["user"]).data})


class GoogleRegisterView(APIView):
    """Second step: create the account from a freshly verified Google token."""

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "registration"

    def post(self, request):
        serializer = GoogleRegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = services.register_google_user(request, **serializer.validated_data)
        return Response(
            {"user": UserPublicSerializer(user).data, "is_new_user": True},
            status=status.HTTP_201_CREATED,
        )


class CompleteOnboardingView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = OnboardingCompleteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = services.complete_onboarding(request.user, **serializer.validated_data)
        return Response(UserPublicSerializer(user).data)