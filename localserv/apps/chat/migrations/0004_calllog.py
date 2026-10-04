import django.db.models.deletion
import django.utils.timezone
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0003_messageattachment_view_once"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="CallLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("mode", models.CharField(choices=[("voice", "Voice"), ("video", "Video")], max_length=5)),
                (
                    "outcome",
                    models.CharField(
                        choices=[
                            ("ringing", "Ringing"),
                            ("in_progress", "In progress"),
                            ("completed", "Answered"),
                            ("no_answer", "No answer"),
                            ("declined", "Declined"),
                            ("busy", "Busy"),
                            ("cancelled", "Cancelled"),
                            ("failed", "Failed"),
                        ],
                        default="ringing",
                        max_length=12,
                    ),
                ),
                ("started_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("answered_at", models.DateTimeField(blank=True, null=True)),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                ("duration_seconds", models.PositiveIntegerField(default=0)),
                (
                    "callee",
                    models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="+", to=settings.AUTH_USER_MODEL),
                ),
                (
                    "caller",
                    models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="+", to=settings.AUTH_USER_MODEL),
                ),
                (
                    "conversation",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="calls",
                        to="chat.conversation",
                    ),
                ),
            ],
            options={
                "db_table": "chat_call_log",
                "abstract": False,
            },
        ),
        migrations.AddIndex(
            model_name="calllog",
            index=models.Index(fields=["caller", "-started_at"], name="chat_call_caller_idx"),
        ),
        migrations.AddIndex(
            model_name="calllog",
            index=models.Index(fields=["callee", "-started_at"], name="chat_call_callee_idx"),
        ),
        migrations.AddIndex(
            model_name="calllog",
            index=models.Index(fields=["-started_at"], name="chat_call_started_idx"),
        ),
        migrations.AddConstraint(
            model_name="calllog",
            constraint=models.UniqueConstraint(
                condition=models.Q(("ended_at__isnull", True)),
                fields=("conversation",),
                name="one_open_call_per_conversation",
            ),
        ),
    ]
