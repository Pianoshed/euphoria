import django.db.models.deletion
import django.utils.timezone
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0010_merge_20261005_0952"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="GroupCall",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("mode", models.CharField(choices=[("voice", "Voice"), ("video", "Video")], default="video", max_length=5)),
                ("started_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                ("peak_participants", models.PositiveSmallIntegerField(default=0)),
                ("duration_seconds", models.PositiveIntegerField(default=0)),
                ("conversation", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="group_calls", to="chat.conversation")),
                ("started_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "chat_group_call",
                "abstract": False,
            },
        ),
        migrations.CreateModel(
            name="GroupCallParticipant",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("joined_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("left_at", models.DateTimeField(blank=True, null=True)),
                ("call", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="participants", to="chat.groupcall")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "chat_group_call_participant",
                "abstract": False,
            },
        ),
        migrations.AddIndex(
            model_name="groupcall",
            index=models.Index(fields=["-started_at"], name="chat_gcall_started_idx"),
        ),
        migrations.AddConstraint(
            model_name="groupcall",
            constraint=models.UniqueConstraint(condition=models.Q(("ended_at__isnull", True)), fields=("conversation",), name="one_open_group_call_per_conversation"),
        ),
        migrations.AddConstraint(
            model_name="groupcallparticipant",
            constraint=models.UniqueConstraint(condition=models.Q(("left_at__isnull", True)), fields=("call", "user"), name="one_open_seat_per_user_per_group_call"),
        ),
    ]
