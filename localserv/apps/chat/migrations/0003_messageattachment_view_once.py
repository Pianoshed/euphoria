import apps.chat.models
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0002_messageattachment_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="messageattachment",
            name="view_once",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="messageattachment",
            name="viewed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="messageattachment",
            name="file",
            field=models.ImageField(blank=True, upload_to=apps.chat.models.message_attachment_upload_path),
        ),
    ]
