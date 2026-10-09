from django.db import migrations

from apps.common.migration_utils import decrypt_existing, encrypt_existing


def forwards(apps, schema_editor):
    encrypt_existing(schema_editor, apps.get_model("accounts", "User"), "two_factor_secret")


def backwards(apps, schema_editor):
    decrypt_existing(schema_editor, apps.get_model("accounts", "User"), "two_factor_secret")


class Migration(migrations.Migration):
    """Data step: encrypt secrets that were saved as plain text before this change."""

    dependencies = [
        ("accounts", "0006_two_factor_secret_encrypted_field"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
