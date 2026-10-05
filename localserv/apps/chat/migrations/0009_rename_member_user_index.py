from django.db import migrations


class Migration(migrations.Migration):
    """0007 gave the ConversationMember(user) index a hand-written name; Django derives
    a different one from the model, so makemigrations kept asking for this rename."""

    dependencies = [
        ("chat", "0008_group_pins_and_moods"),
    ]

    operations = [
        migrations.RenameIndex(
            model_name="conversationmember",
            new_name="chat_conver_user_id_f535b5_idx",
            old_name="chat_conver_user_id_7c1f2e_idx",
        ),
    ]
