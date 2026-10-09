from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("bookings", "0003_alter_booking_status")]

    operations = [
        migrations.AddField(model_name="booking", name="quantity", field=models.PositiveIntegerField(default=1)),
        migrations.AddField(model_name="booking", name="unit_price", field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True)),
        migrations.AddField(model_name="booking", name="gross_amount", field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True)),
        migrations.AddField(model_name="booking", name="platform_fee_rate", field=models.DecimalField(blank=True, decimal_places=4, max_digits=7, null=True)),
        migrations.AddField(model_name="booking", name="platform_fee_amount", field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True)),
        migrations.AddField(model_name="booking", name="planner_amount", field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True)),
        migrations.AddField(model_name="booking", name="currency", field=models.CharField(default="NGN", max_length=3)),
        migrations.AddField(model_name="booking", name="payment_source", field=models.CharField(default="WALLET", max_length=30)),
        migrations.AddField(model_name="booking", name="purchase_idempotency_key", field=models.CharField(blank=True, max_length=100, null=True, unique=True)),
    ]
