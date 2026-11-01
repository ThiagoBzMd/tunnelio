from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"

    def ready(self):
        from django.contrib.auth.signals import user_logged_in, user_logged_out

        from . import sessions

        user_logged_in.connect(
            lambda sender, request, user, **_: sessions.record(request, user), weak=False, dispatch_uid="login_session_in"
        )
        user_logged_out.connect(
            lambda sender, request, user, **_: sessions.forget(getattr(request.session, "session_key", None)),
            weak=False,
            dispatch_uid="login_session_out",
        )
