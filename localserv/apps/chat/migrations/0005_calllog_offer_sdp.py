from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("chat", "0004_calllog"),
    ]

    operations = [
        migrations.AddField(
            model_name="calllog",
            name="offer_sdp",
            field=models.TextField(blank=True, default=""),
        ),
    ]
