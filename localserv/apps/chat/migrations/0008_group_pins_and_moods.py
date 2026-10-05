import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0007_group_conversations"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="message",
            name="pinned_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="message",
            name="pinned_by",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="+", to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="conversationmember",
            name="mood",
            field=models.CharField(
                blank=True, default="", max_length=5,
                choices=[("happy", "Happy"), ("calm", "Calm"), ("meh", "Bleh"), ("low", "Low"), ("upset", "Upset")],
            ),
        ),
        migrations.AddField(
            model_name="conversationmember",
            name="mood_set_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
