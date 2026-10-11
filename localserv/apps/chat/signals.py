import logging

from django.db.models.signals import post_save
from django.dispatch import receiver

from . import notify
from .models import CallLog, Message

log = logging.getLogger("apps")

# Same set the frontend (AlertsContext) counts as "missed" for the person who was called.
MISSED_OUTCOMES = {CallLog.Outcome.NO_ANSWER, CallLog.Outcome.BUSY, CallLog.Outcome.CANCELLED}


@receiver(post_save, sender=Message)
def push_new_message(sender, instance, created, raw=False, **kwargs):
    if raw or not created:
        return
    try:
        notify.notify_new_message(instance)
    except Exception:
        log.warning("Could not queue the new-message push", exc_info=True)


@receiver(post_save, sender=CallLog)
def push_missed_call(sender, instance, raw=False, **kwargs):
    if raw or instance.outcome not in MISSED_OUTCOMES or not instance.callee_id:
        return
    try:
        notify.push_to_users([instance.callee_id], {"type": "missed_call"})
    except Exception:
        log.warning("Could not queue the missed-call push", exc_info=True)
