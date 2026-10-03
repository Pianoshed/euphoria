from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.accounts.models import User

from .models import Wallet


@receiver(post_save, sender=User)
def create_wallet(sender, instance, created, **kwargs):
    if not created:
        return
    Wallet.objects.get_or_create(user=instance)
