import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0006_messageattachment_voice_notes"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="conversation",
            name="is_group",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="conversation",
            name="title",
            field=models.CharField(blank=True, max_length=80),
        ),
        migrations.AddField(
            model_name="conversation",
            name="created_by",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="+", to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="conversation",
            name="user_a",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name="+", to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="conversation",
            name="user_b",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name="+", to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddConstraint(
            model_name="conversation",
            constraint=models.CheckConstraint(
                condition=models.Q(("is_group", True), models.Q(("user_a__isnull", False), ("user_b__isnull", False)), _connector="OR"),
                name="direct_conversation_has_both_users",
            ),
        ),
        migrations.CreateModel(
            name="ConversationMember",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("role", models.CharField(choices=[("admin", "Admin"), ("member", "Member")], default="member", max_length=6)),
                ("conversation", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="members", to="chat.conversation")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "chat_conversation_member",
                "abstract": False,
            },
        ),
        migrations.AddIndex(
            model_name="conversationmember",
            index=models.Index(fields=["user"], name="chat_conver_user_id_7c1f2e_idx"),
        ),
        migrations.AddConstraint(
            model_name="conversationmember",
            constraint=models.UniqueConstraint(fields=("conversation", "user"), name="unique_conversation_member"),
        ),
    ]
