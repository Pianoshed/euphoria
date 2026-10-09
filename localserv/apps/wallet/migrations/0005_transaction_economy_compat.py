from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("wallet", "0004_payout_destination")]

    operations = [
        migrations.AlterField(model_name="ledgerentry", name="entry_type", field=models.CharField(choices=[
            ("TOKEN_DEPOSIT", "Token deposit"), ("ESCROW_HOLD", "Escrow hold"), ("ESCROW_RELEASE", "Escrow release"),
            ("ESCROW_REFUND", "Escrow refund"), ("ADMIN_ADJUSTMENT", "Admin adjustment"), ("PLAN_PAYMENT", "Plan payment"),
            ("PLAN_REFUND", "Plan refund"), ("PLANNER_EARNING", "Planner earning"), ("PLATFORM_FEE", "Platform fee"),
            ("EARNINGS_REVERSAL", "Earnings reversal"), ("GIFT_CREDIT", "Gift credit"), ("GIFT_DEBIT", "Gift debit"),
            ("PROMOTIONAL_CREDIT", "Promotional credit"), ("WITHDRAWAL", "Withdrawal"), ("WITHDRAWAL_REVERSAL", "Withdrawal reversal")
        ], max_length=30)),
        migrations.AddField(model_name="withdrawalrequest", name="source", field=models.CharField(default="WALLET", max_length=20)),
    ]
