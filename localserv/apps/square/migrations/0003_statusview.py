import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('square', '0002_friend_tree_member_label'),
    ]

    operations = [
        migrations.CreateModel(
            name='StatusView',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('status', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='views', to='square.status')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'square_status_view',
                'abstract': False,
            },
        ),
        migrations.AddConstraint(
            model_name='statusview',
            constraint=models.UniqueConstraint(fields=('status', 'user'), name='unique_status_view'),
        ),
    ]
