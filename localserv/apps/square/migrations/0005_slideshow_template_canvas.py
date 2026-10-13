from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("square", "0004_slideshow_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="status",
            name="template",
            field=models.CharField(blank=True, default="", max_length=12),
        ),
        migrations.AddField(
            model_name="status",
            name="canvas",
            field=models.CharField(blank=True, default="", max_length=12),
        ),
    ]
