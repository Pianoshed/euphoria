from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Profile, ProfilePrivacy, User


@receiver(post_save, sender=User)
def create_profile_and_privacy(sender, instance, created, **kwargs):
    if not created:
        return
    Profile.objects.get_or_create(user=instance)
    ProfilePrivacy.objects.get_or_create(user=instance)
