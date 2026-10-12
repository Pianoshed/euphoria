from django.db import migrations, models

TRIGRAM_INDEXES = [
    ("accounts_user_username_trgm", "accounts_user", "username"),
    ("accounts_profile_display_name_trgm", "accounts_profile", "display_name"),
    ("accounts_profile_location_trgm", "accounts_profile", "general_location"),
]


def add_trigram_indexes(apps, schema_editor):
    """Speeds up the Find people `q` search (icontains). Postgres only; skipped elsewhere (tests/sqlite)."""
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    for name, table, column in TRIGRAM_INDEXES:
        schema_editor.execute(
            f'CREATE INDEX IF NOT EXISTS {name} ON {table} USING gin ("{column}" gin_trgm_ops)'
        )


def drop_trigram_indexes(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for name, _table, _column in TRIGRAM_INDEXES:
        schema_editor.execute(f"DROP INDEX IF EXISTS {name}")


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0007_encrypt_existing_two_factor_secrets"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="user",
            index=models.Index(fields=["status", "role", "id"], name="acct_user_discover_idx"),
        ),
        migrations.RunPython(add_trigram_indexes, drop_trigram_indexes),
    ]
