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
    if ext not in (".jpg", ".webp", ".webm", ".mp4"):
        ext = ".jpg"
    return f"square_status/{instance.user_id}/{uuid.uuid4().hex}{ext}"


def slide_upload_path(instance, filename):
    return f"square_status/{instance.status.user_id}/{uuid.uuid4().hex}.webp"


def default_expiry():
    return timezone.now() + STATUS_TTL


class Status(BaseModel):
    """A 24-hour picture, slideshow, short video (max 15s) or text status. Hidden by every query once
    expires_at passes; files are deleted by services.purge_expired().

    A slideshow keeps its pictures in StatusSlide rows (2-7 small WebP files, 15 s in total) and, optionally, a music
    *reference* in `music` (title, artist, licence, stream URL of a free/CC track). The audio itself is never
    copied into our bucket."""

    class Kind(models.TextChoices):
        TEXT = "text", "Text"
        IMAGE = "image", "Image"
        VIDEO = "video", "Video"
        SLIDESHOW = "slideshow", "Slideshow"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.TEXT)
    text = models.CharField(max_length=140, blank=True)
    file = models.FileField(upload_to=status_upload_path, blank=True)
    duration_seconds = models.PositiveSmallIntegerField(null=True, blank=True)
    # Slideshow only. `cover` is a ~360px thumbnail of slide 1 so the status list/ring never downloads full slides.
    cover = models.FileField(upload_to=status_upload_path, blank=True)
    slide_seconds = models.PositiveSmallIntegerField(null=True, blank=True)
    music = models.JSONField(null=True, blank=True)
    # Slideshow look: motion between photos and the stage they sit on (names validated in media.TEMPLATES / CANVASES).
    template = models.CharField(max_length=12, blank=True, default="")
    canvas = models.CharField(max_length=12, blank=True, default="")
    expires_at = models.DateTimeField(default=default_expiry)

    class Meta(BaseModel.Meta):
        db_table = "square_status"
        indexes = [models.Index(fields=["expires_at"])]


class StatusSlide(BaseModel):
    """One picture of a slideshow status. Deleted (row + file) with its status."""

    status = models.ForeignKey(Status, on_delete=models.CASCADE, related_name="slides")
    position = models.PositiveSmallIntegerField()
    file = models.FileField(upload_to=slide_upload_path)
    width = models.PositiveSmallIntegerField()
    height = models.PositiveSmallIntegerField()

    class Meta(BaseModel.Meta):
        db_table = "square_status_slide"
        ordering = ["position"]
        constraints = [models.UniqueConstraint(fields=["status", "position"], name="unique_status_slide_position")]


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
