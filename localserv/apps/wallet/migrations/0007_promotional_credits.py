from django.db import migrations, models
import uuid
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("wallet", "0006_withdrawal_earning_allocations"), ("services", "0003_plan_fields")]

    operations = [
        migrations.AddField(
            model_name="wallet", name="promotional_balance",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
        migrations.AddConstraint(
            model_name="wallet",
            constraint=models.CheckConstraint(condition=models.Q(promotional_balance__gte=0), name="wallet_promotional_balance_non_negative"),
        ),
        migrations.CreateModel(
            name="PromotionalCredit",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("original_amount", models.DecimalField(decimal_places=2, max_digits=12)),
                ("remaining_amount", models.DecimalField(decimal_places=2, max_digits=12)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                ("non_transferable", models.BooleanField(default=True)),
                ("non_withdrawable", models.BooleanField(default=True)),
                ("source", models.CharField(default="PROMOTION", max_length=80)),
                ("reference", models.CharField(max_length=120, unique=True)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("category", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="promotional_credits", to="services.servicecategory")),
                ("plan", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="promotional_credits", to="services.service")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="promotional_credits", to="accounts.user")),
            ],
            options={"db_table": "wallet_promotional_credit"},
        ),
        migrations.AddConstraint(
            model_name="promotionalcredit",
            constraint=models.CheckConstraint(condition=models.Q(original_amount__gt=0), name="promo_original_positive"),
        ),
        migrations.AddConstraint(
            model_name="promotionalcredit",
            constraint=models.CheckConstraint(condition=models.Q(remaining_amount__gte=0), name="promo_remaining_non_negative"),
        ),
        migrations.AddConstraint(
            model_name="promotionalcredit",
            constraint=models.CheckConstraint(condition=models.Q(remaining_amount__lte=models.F("original_amount")), name="promo_remaining_lte_original"),
        ),
        migrations.AddIndex(model_name="promotionalcredit", index=models.Index(fields=["user", "expires_at"], name="wallet_promo_user_expiry_idx")),
        migrations.AddIndex(model_name="promotionalcredit", index=models.Index(fields=["user", "remaining_amount"], name="wallet_promo_user_remaining_idx")),
    ]
