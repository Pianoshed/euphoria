from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("wallet", "0005_transaction_economy_compat")]
    operations = [
        migrations.AddField(
            model_name="withdrawalrequest",
            name="earning_allocations",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
