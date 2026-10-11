import logging

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.accounts.models import User

from .models import LedgerEntry, Wallet


@receiver(post_save, sender=User)
def create_wallet(sender, instance, created, **kwargs):
    if not created:
        return
    Wallet.objects.get_or_create(user=instance)


@receiver(post_save, sender=LedgerEntry)
def push_wallet_credit(sender, instance, created, raw=False, **kwargs):
    """Money landed in a wallet: tell the owner's open tabs (no amount is sent) so the receipt popup shows
    at once instead of waiting for the next poll."""
    if raw or not created or instance.amount <= 0:
        return
    try:
        from apps.chat.notify import push_to_users

        push_to_users([instance.wallet.user_id], {"type": "wallet"})
    except Exception:
        logging.getLogger("apps").warning("Could not queue the wallet push", exc_info=True)
