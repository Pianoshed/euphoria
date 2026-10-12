from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.common.constants import AccountStatus

from .models import Profile, ProfilePrivacy, User


@receiver(post_save, sender=User)
def create_profile_and_privacy(sender, instance, created, **kwargs):
    if not created:
        return
    Profile.objects.get_or_create(user=instance)
    ProfilePrivacy.objects.get_or_create(user=instance)


@receiver(post_save, sender=User)
def close_sockets_when_account_not_active(sender, instance, created, raw=False, update_fields=None, **kwargs):
    """Suspended / banned / deactivated: drop their open WebSockets now, not whenever they next reconnect."""
    if raw or created or instance.status == AccountStatus.ACTIVE:
        return
    if update_fields is not None and "status" not in update_fields:
        return  # e.g. last_login bookkeeping on an account that was already closed
    try:
        from apps.chat.notify import close_user_sockets

        close_user_sockets(instance.pk)
    except Exception:
        import logging

        logging.getLogger("apps").warning("Could not queue the socket close", exc_info=True)
