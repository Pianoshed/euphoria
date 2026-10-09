from django.db import migrations

import apps.common.fields


class Migration(migrations.Migration):
    """Schema step: the column becomes unbounded text (the 4000-character limit stays in the serializers)."""

    dependencies = [
        ("chat", "0011_group_calls"),
    ]

    operations = [
        migrations.AlterField(
            model_name="message",
            name="body",
            field=apps.common.fields.EncryptedTextField(blank=True),
        ),
    ]
