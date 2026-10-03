from django.db import connection

cursor = connection.cursor()

cursor.execute("""
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'accounts_user'
    ORDER BY column_name
""")
print("=== accounts_user columns ===")
for row in cursor.fetchall():
    print(row[0])

cursor.execute("""
    SELECT app, name, applied
    FROM django_migrations
    WHERE app = 'accounts'
    ORDER BY applied
""")
print()
print("=== applied accounts migrations ===")
for row in cursor.fetchall():
    print(row)