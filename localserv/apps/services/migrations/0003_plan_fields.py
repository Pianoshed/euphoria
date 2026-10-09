from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("services", "0002_category_icon_and_fun_categories")]

    operations = [
        migrations.AddField(model_name="service", name="is_plan", field=models.BooleanField(default=False)),
        migrations.AddField(model_name="service", name="capacity", field=models.PositiveIntegerField(blank=True, null=True)),
        migrations.AddField(model_name="service", name="scheduled_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name="service", name="location", field=models.CharField(blank=True, max_length=255)),
        migrations.AddField(model_name="service", name="cancellation_policy", field=models.CharField(default="FULL_REFUND", max_length=30)),
        migrations.AddField(model_name="service", name="platform_fee_rate", field=models.DecimalField(blank=True, decimal_places=4, max_digits=7, null=True)),
    ]
