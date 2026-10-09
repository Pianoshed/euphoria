"""Re-encrypt every EncryptedTextField under the current first key in FIELD_ENCRYPTION_KEYS.

Usage: prepend the new key to FIELD_ENCRYPTION_KEYS, deploy, run this command, then drop the old key.
"""
from django.apps import apps
from django.core.management.base import BaseCommand
from django.db import connection

from apps.common.fields import EncryptedTextField, is_encrypted, rotate_text


class Command(BaseCommand):
    help = "Re-encrypt all encrypted fields (and any leftover plain text) under the current key."

    def handle(self, *args, **options):
        total = 0
        for model in apps.get_models():
            for field in model._meta.get_fields():
                if not isinstance(field, EncryptedTextField):
                    continue
                table, col, pk = model._meta.db_table, field.column, model._meta.pk.column
                with connection.cursor() as cur:
                    cur.execute(f'SELECT "{pk}", "{col}" FROM "{table}" WHERE "{col}" <> %s', [""])
                    rows = cur.fetchall()
                for pk_value, raw in rows:
                    if raw is None:
                        continue
                    new = rotate_text(raw if is_encrypted(raw) else raw)
                    if new != raw:
                        with connection.cursor() as cur:
                            cur.execute(f'UPDATE "{table}" SET "{col}" = %s WHERE "{pk}" = %s', [new, pk_value])
                        total += 1
                self.stdout.write(f"{model.__name__}.{field.name}: checked {len(rows)}")
        self.stdout.write(self.style.SUCCESS(f"Re-encrypted {total} value(s)."))
