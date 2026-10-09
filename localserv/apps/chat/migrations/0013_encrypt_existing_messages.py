from django.db import migrations

from apps.common.migration_utils import decrypt_existing, encrypt_existing


def forwards(apps, schema_editor):
    encrypt_existing(schema_editor, apps.get_model("chat", "Message"), "body")


def backwards(apps, schema_editor):
    decrypt_existing(schema_editor, apps.get_model("chat", "Message"), "body")


class Migration(migrations.Migration):
    """Data step: encrypt messages that were saved as plain text before this change."""

    dependencies = [
        ("chat", "0012_message_body_encrypted_field"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
