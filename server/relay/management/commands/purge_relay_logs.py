"""Delete relay connection logs older than RELAY_LOG_RETENTION_DAYS, stale pairing sessions and
expired e-mail codes and accounts that never confirmed their e-mail."""

from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import EmailCode, LoginSession
from devices.models import PairingSession
from relay.models import ConnectionLog


class Command(BaseCommand):
    help = "Purge relay metadata past retention (default: RELAY_LOG_RETENTION_DAYS) and stale pairing sessions."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=settings.RELAY_LOG_RETENTION_DAYS)

    def handle(self, *args, **options):
        cutoff = timezone.now() - timedelta(days=options["days"])
        logs, _ = ConnectionLog.objects.filter(connected_at__lt=cutoff).delete()
        pairings, _ = PairingSession.objects.filter(expires_at__lt=timezone.now() - timedelta(days=1)).delete()
        codes, _ = EmailCode.objects.filter(expires_at__lt=timezone.now() - timedelta(days=1)).delete()
        stale = timezone.now() - timedelta(days=settings.UNVERIFIED_ACCOUNT_TTL_DAYS)
        users, _ = get_user_model().objects.filter(is_active=False, is_staff=False, created_at__lt=stale).delete()
        alive = Session.objects.filter(expire_date__gt=timezone.now()).values("session_key")
        logins, _ = LoginSession.objects.exclude(session_key__in=alive).delete()
        self.stdout.write(
            f"purged {logs} connection logs, {pairings} pairing sessions, {codes} e-mail codes, {users} unverified accounts, "
            f"{logins} ended login sessions"
        )
