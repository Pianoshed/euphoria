import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0008_group_pins_and_moods"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="conversation",
            name="invite_code",
            field=models.CharField(blank=True, max_length=32, null=True, unique=True),
        ),
        migrations.CreateModel(
            name="GroupJoinRequest",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "Pending"), ("approved", "Approved"), ("declined", "Declined")],
                        default="pending", max_length=8,
                    ),
                ),
                ("decided_at", models.DateTimeField(blank=True, null=True)),
                (
                    "conversation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="join_requests", to="chat.conversation"
                    ),
                ),
                (
                    "decided_by",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+", to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL
                    ),
                ),
            ],
            options={
                "db_table": "chat_group_join_request",
                "abstract": False,
                "indexes": [models.Index(fields=["conversation", "status"], name="chat_joinreq_conv_status_idx")],
                "constraints": [
                    models.UniqueConstraint(fields=("conversation", "user"), name="unique_group_join_request")
                ],
            },
        ),
    ]
