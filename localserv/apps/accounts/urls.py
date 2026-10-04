from django.urls import path

from . import views

app_name = "accounts"

urlpatterns = [
    path("csrf/", views.CSRFBootstrapView.as_view(), name="csrf"),
    path("register/", views.RegisterView.as_view(), name="register"),
    path("verify-email/", views.VerifyEmailView.as_view(), name="verify-email"),
    path("resend-verification/", views.ResendVerificationView.as_view(), name="resend-verification"),
    path("login/", views.LoginView.as_view(), name="login"),
    path("login/verify-2fa/", views.LoginMFAView.as_view(), name="login-verify-2fa"),
    path("logout/", views.LogoutView.as_view(), name="logout"),
    path("password/reset/", views.PasswordResetRequestView.as_view(), name="password-reset"),
    path("password/reset/confirm/", views.PasswordResetConfirmView.as_view(), name="password-reset-confirm"),
    path("password/change/", views.PasswordChangeView.as_view(), name="password-change"),
    path("sessions/", views.SessionListView.as_view(), name="sessions"),
    path("sessions/<uuid:session_id>/revoke/", views.SessionRevokeView.as_view(), name="session-revoke"),
    path("sessions/revoke-all/", views.SessionRevokeAllView.as_view(), name="sessions-revoke-all"),
    path("2fa/setup/", views.TwoFactorSetupView.as_view(), name="2fa-setup"),
    path("2fa/confirm/", views.TwoFactorConfirmView.as_view(), name="2fa-confirm"),
    path("2fa/disable/", views.TwoFactorDisableView.as_view(), name="2fa-disable"),

    path("profile/me/", views.MyProfileView.as_view(), name="my-profile"),
    path("profile/privacy/", views.MyPrivacyView.as_view(), name="my-privacy"),
    path("profile/avatar/", views.AvatarUploadView.as_view(), name="avatar-upload"),
    path("profile/onboarding/complete/", views.CompleteOnboardingView.as_view(), name="onboarding-complete"),
    path("profile/<uuid:user_id>/", views.PublicProfileView.as_view(), name="public-profile"),
    path("discover/", views.DiscoverProfilesView.as_view(), name="discover"),
    path("presence/ping/", views.PresencePingView.as_view(), name="presence-ping"),
    path("google/", views.GoogleLoginView.as_view(), name="google-login"),
    path("google/register/", views.GoogleRegisterView.as_view(), name="google-register"),
    path("blocks/", views.BlockListCreateView.as_view(), name="blocks"),
    path("blocks/<uuid:user_id>/", views.BlockDeleteView.as_view(), name="block-delete"),
]