from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("chat", "0013_encrypt_existing_messages")]

    operations = [
        migrations.AddIndex(
            model_name="messageattachment",
            index=models.Index(fields=["kind", "created_at"], name="chat_att_kind_created_idx"),
        ),
    ]
