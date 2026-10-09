"""Helpers for data migrations that encrypt / decrypt an EncryptedTextField in place."""
from apps.common.fields import PREFIX, decrypt_text, encrypt_text

BATCH = 500


def _rewrite(schema_editor, model, column, transform, where_sql):
    table, pk = model._meta.db_table, model._meta.pk.column
    conn = schema_editor.connection
    with conn.cursor() as cur:
        cur.execute(f'SELECT "{pk}", "{column}" FROM "{table}" WHERE {where_sql}', [PREFIX + "%"] if "%s" in where_sql else [])
        rows = cur.fetchall()
    for i in range(0, len(rows), BATCH):
        with conn.cursor() as cur:
            for pk_value, raw in rows[i:i + BATCH]:
                cur.execute(f'UPDATE "{table}" SET "{column}" = %s WHERE "{pk}" = %s', [transform(raw), pk_value])


def encrypt_existing(schema_editor, model, column):
    """Encrypt every non-empty value that is still plain text."""
    _rewrite(schema_editor, model, column, encrypt_text, f'"{column}" <> \'\' AND "{column}" NOT LIKE %s')


def decrypt_existing(schema_editor, model, column):
    """Reverse: turn encrypted values back into plain text."""
    _rewrite(schema_editor, model, column, decrypt_text, f'"{column}" LIKE %s')
