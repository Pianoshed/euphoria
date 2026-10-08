import os
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.common.models import BaseModel

STATUS_TTL = timedelta(hours=24)
REACTION_EMOJI = ["🔥", "😂", "❤️", "😮", "👏"]


def status_upload_path(instance, filename):
    # Extension comes from OUR sniffed type (see media.py), never the client's filename.
    ext = os.path.splitext(filename)[1].lower()
    if ext not in (".jpg", ".webm", ".mp4"):
        ext = ".jpg"
    return f"square_status/{instance.user_id}/{uuid.uuid4().hex}{ext}"


def default_expiry():
    return timezone.now() + STATUS_TTL


class Status(BaseModel):
    """A 24-hour picture, short video (max 15s) or text status. Hidden by every query once
    expires_at passes; files are deleted by services.purge_expired()."""

    class Kind(models.TextChoices):
        TEXT = "text", "Text"
        IMAGE = "image", "Image"
        VIDEO = "video", "Video"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=5, choices=Kind.choices, default=Kind.TEXT)
    text = models.CharField(max_length=140, blank=True)
    file = models.FileField(upload_to=status_upload_path, blank=True)
    duration_seconds = models.PositiveSmallIntegerField(null=True, blank=True)
    expires_at = models.DateTimeField(default=default_expiry)

    class Meta(BaseModel.Meta):
        db_table = "square_status"
        indexes = [models.Index(fields=["expires_at"])]


class StatusReaction(BaseModel):
    """One emoji per person per status. Tapping the same emoji again removes it."""

    status = models.ForeignKey(Status, on_delete=models.CASCADE, related_name="reactions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    emoji = models.CharField(max_length=8)

    class Meta(BaseModel.Meta):
        db_table = "square_status_reaction"
        constraints = [models.UniqueConstraint(fields=["status", "user"], name="unique_status_reaction")]


class StatusView(BaseModel):
    """Marks a status as watched by a person, so "seen" survives refreshes and follows them across devices.
    Rows disappear with the status (CASCADE) when services.purge_expired() deletes it."""

    status = models.ForeignKey(Status, on_delete=models.CASCADE, related_name="views")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")

    class Meta(BaseModel.Meta):
        db_table = "square_status_view"
        constraints = [models.UniqueConstraint(fields=["status", "user"], name="unique_status_view")]


class Thought(BaseModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    text = models.CharField(max_length=280)

    class Meta(BaseModel.Meta):
        db_table = "square_thought"
        indexes = [models.Index(fields=["-created_at"], name="square_thought_recent_idx")]


class ThoughtReaction(BaseModel):
    thought = models.ForeignKey(Thought, on_delete=models.CASCADE, related_name="reactions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    emoji = models.CharField(max_length=8)

    class Meta(BaseModel.Meta):
        db_table = "square_thought_reaction"
        constraints = [models.UniqueConstraint(fields=["thought", "user"], name="unique_thought_reaction")]


class FriendTree(BaseModel):
    """A link-tree of friend bubbles. Anyone can make one; only the owner and the people
    tagged in it can ever see it (every query filters on that, see views._visible)."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    title = models.CharField(max_length=60)
    note = models.CharField(max_length=140, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "square_friend_tree"


class Circle(models.TextChoices):
    """How the tree OWNER knows a person. The owner sees who is in which circle; tagged people only see the tree's shape and their own spot (see views._tree). Only the owner can change it."""

    FAMILY = "family", "Family"
    PARTNER = "partner", "Partner"
    BESTIES = "besties", "Besties"
    FRIENDS = "friends", "Friends"
    WORK = "work", "Workmates"
    SCHOOL = "school", "Classmates"
    NEIGHBOURS = "neighbours", "Neighbours"
    ACQUAINTANCE = "acquaintance", "Acquaintances"


class FriendTreeMember(BaseModel):
    tree = models.ForeignKey(FriendTree, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    label = models.CharField(max_length=16, choices=Circle.choices, default=Circle.FRIENDS)

    class Meta(BaseModel.Meta):
        db_table = "square_friend_tree_member"
        constraints = [models.UniqueConstraint(fields=["tree", "user"], name="unique_tree_member")]
