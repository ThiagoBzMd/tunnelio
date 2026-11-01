from django.urls import path

from preferences.views import PreferencesBlobView

from . import views

urlpatterns = [
    path("csrf", views.CsrfView.as_view(), name="auth-csrf"),
    path("register", views.RegisterView.as_view(), name="auth-register"),
    path("verify-email", views.VerifyEmailView.as_view(), name="auth-verify-email"),
    path("resend-code", views.ResendCodeView.as_view(), name="auth-resend-code"),
    path("login", views.LoginView.as_view(), name="auth-login"),
    path("logout", views.LogoutView.as_view(), name="auth-logout"),
    path("me", views.MeView.as_view(), name="auth-me"),
    path("change-password", views.ChangePasswordView.as_view(), name="auth-change-password"),
    path("account", views.DeleteAccountView.as_view(), name="auth-account"),
    path("password-reset", views.PasswordResetRequestView.as_view(), name="auth-password-reset"),
    path("password-reset/confirm", views.PasswordResetConfirmView.as_view(), name="auth-password-reset-confirm"),
    path("totp/setup", views.TotpSetupView.as_view(), name="auth-totp-setup"),
    path("totp/enable", views.TotpEnableView.as_view(), name="auth-totp-enable"),
    path("totp/disable", views.TotpDisableView.as_view(), name="auth-totp-disable"),
    path("sessions", views.SessionsView.as_view(), name="auth-sessions"),
    path("sessions/logout-all", views.LogoutAllView.as_view(), name="auth-sessions-logout-all"),
    path("sessions/<int:pk>", views.SessionDetailView.as_view(), name="auth-session"),
    path("preferences", PreferencesBlobView.as_view(), name="auth-preferences"),
]
