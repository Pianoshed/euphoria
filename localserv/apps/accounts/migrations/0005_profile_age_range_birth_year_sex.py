from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0004_user_role_confirmed"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="age_range",
            field=models.CharField(
                blank=True,
                choices=[
                    ("UNDER_16", "Under 16"),
                    ("AGE_16_25", "16-25"),
                    ("AGE_26_35", "26-35"),
                    ("AGE_36_60", "36-60"),
                    ("OVER_60", "Over 60"),
                ],
                max_length=12,
            ),
        ),
        migrations.AddField(
            model_name="profile",
            name="birth_year",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="profile",
            name="sex",
            field=models.CharField(
                choices=[
                    ("M", "Male"),
                    ("F", "Female"),
                    ("PNS", "Prefer not to say"),
                    ("UNDISCLOSED", "Undisclosed"),
                ],
                default="UNDISCLOSED",
                max_length=12,
            ),
        ),
    ]
