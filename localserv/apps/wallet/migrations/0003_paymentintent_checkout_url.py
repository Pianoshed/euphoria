from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0002_alter_ledgerentry_entry_type_paymentintent_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="paymentintent",
            name="checkout_url",
            field=models.URLField(blank=True, default="", max_length=500),
        ),
    ]
