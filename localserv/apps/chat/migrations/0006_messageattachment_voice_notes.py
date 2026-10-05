import apps.chat.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0005_calllog_offer_sdp"),
    ]

    operations = [
        migrations.AddField(
            model_name="messageattachment",
            name="kind",
            field=models.CharField(
                choices=[("image", "Image"), ("audio", "Voice note")], default="image", max_length=5
            ),
        ),
        migrations.AddField(
            model_name="messageattachment",
            name="duration_seconds",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="messageattachment",
            name="file",
            field=models.FileField(blank=True, upload_to=apps.chat.models.message_attachment_upload_path),
        ),
    ]
