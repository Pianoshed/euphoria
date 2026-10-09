from django.db import migrations

import apps.common.fields


class Migration(migrations.Migration):
    """Schema step: the column becomes unbounded text (a Fernet token is longer than 64 chars)."""

    dependencies = [
        ("accounts", "0005_profile_age_range_birth_year_sex"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="two_factor_secret",
            field=apps.common.fields.EncryptedTextField(blank=True),
        ),
    ]
