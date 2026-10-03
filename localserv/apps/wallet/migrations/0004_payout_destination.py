from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0003_paymentintent_checkout_url"),
    ]

    operations = [
        migrations.AddField(
            model_name="payoutaccount",
            name="bank_code",
            field=models.CharField(blank=True, default="", max_length=10),
        ),
        migrations.AddField(
            model_name="payoutaccount",
            name="account_name",
            field=models.CharField(blank=True, default="", max_length=150),
        ),
        migrations.AddField(
            model_name="payoutaccount",
            name="destination_ciphertext",
            field=models.TextField(blank=True, default="", editable=False),
        ),
        migrations.AddField(
            model_name="payoutaccount",
            name="destination_fingerprint",
            field=models.CharField(blank=True, default="", editable=False, max_length=64),
        ),
        migrations.AddConstraint(
            model_name="payoutaccount",
            constraint=models.UniqueConstraint(
                condition=models.Q(("destination_fingerprint", ""), _negated=True),
                fields=("user", "destination_fingerprint"),
                name="unique_user_payout_destination",
            ),
        ),
        migrations.AlterField(
            model_name="withdrawalrequest",
            name="provider_reference",
            field=models.CharField(blank=True, db_index=True, default="", max_length=100),
        ),
    ]
