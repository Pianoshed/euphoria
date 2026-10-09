from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("services", "0003_plan_fields"),
        ("wallet", "0008_rename_wallet_promo_user_expiry_idx_wallet_prom_user_id_a2826e_idx_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="PromoCode",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("code", models.CharField(max_length=40, unique=True)),
                ("name", models.CharField(help_text="Shown to the person who redeems it, e.g. 'Welcome gift'.", max_length=80)),
                ("amount", models.DecimalField(decimal_places=2, max_digits=12)),
                ("max_redemptions", models.PositiveIntegerField(blank=True, help_text="Empty = unlimited.", null=True)),
                ("redeemed_count", models.PositiveIntegerField(default=0)),
                ("starts_at", models.DateTimeField(blank=True, null=True)),
                ("valid_until", models.DateTimeField(blank=True, help_text="The code stops working after this. Empty = never.", null=True)),
                ("credit_valid_days", models.PositiveIntegerField(blank=True, help_text="How long the credit lasts once redeemed. Empty = no expiry.", null=True)),
                ("is_active", models.BooleanField(default=True)),
                ("category", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="promo_codes", to="services.servicecategory")),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="promo_codes_created", to=settings.AUTH_USER_MODEL)),
                ("plan", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="promo_codes", to="services.service")),
            ],
            options={"db_table": "wallet_promo_code"},
        ),
        migrations.AddConstraint(
            model_name="promocode",
            constraint=models.CheckConstraint(condition=models.Q(amount__gt=0), name="promo_code_amount_positive"),
        ),
        migrations.CreateModel(
            name="PromoRedemption",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("credit", models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name="redemption", to="wallet.promotionalcredit")),
                ("promo_code", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="redemptions", to="wallet.promocode")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="promo_redemptions", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "wallet_promo_redemption"},
        ),
        migrations.AddConstraint(
            model_name="promoredemption",
            constraint=models.UniqueConstraint(fields=("promo_code", "user"), name="promo_redeem_once_per_user"),
        ),
    ]
