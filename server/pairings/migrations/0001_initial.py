"""Adopt the pairings table from the former `vault` app (rev. 1.3 removed cloud storage; rev. 1.4 renames
the app). Existing installs have `vault_pairings_blob` with data: it is renamed, not recreated.
Fresh installs get the table created here."""

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def adopt_table(apps, schema_editor):
    conn = schema_editor.connection
    tables = set(conn.introspection.table_names())
    model = apps.get_model("pairings", "PairingsBlob")
    if "vault_pairings_blob" in tables:
        schema_editor.alter_db_table(model, "vault_pairings_blob", "pairings_blob")
    elif "pairings_blob" not in tables:
        schema_editor.create_model(model)
    # The old app's bookkeeping rows are not needed any more.
    ContentType = apps.get_model("contenttypes", "ContentType")
    ContentType.objects.filter(app_label="vault").delete()


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("contenttypes", "0002_remove_content_type_name"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name="PairingsBlob",
                    fields=[
                        ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                        ("timestamp", models.DateTimeField()),
                        ("ciphertext", models.BinaryField()),
                        ("size", models.PositiveIntegerField()),
                        ("updated_at", models.DateTimeField(auto_now=True)),
                        (
                            "user",
                            models.OneToOneField(
                                on_delete=django.db.models.deletion.CASCADE,
                                related_name="pairings_blob",
                                to=settings.AUTH_USER_MODEL,
                            ),
                        ),
                    ],
                    options={"db_table": "pairings_blob"},
                ),
            ],
            database_operations=[],  # the table is adopted or created below, once the model is in the state
        ),
        migrations.RunPython(adopt_table, noop),
    ]
