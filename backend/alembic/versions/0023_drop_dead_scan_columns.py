"""Drop dead scan_* columns from games; add missing id indexes.

Migration 0001 created scan_filename, scan_glb_filename, and scan_featured
columns on the games table, but no ORM model, router, or frontend code ever
used them. They are dead schema from an abandoned 3D-scan feature. Drop them
so the migration chain matches Base.metadata (caught by test_migration_drift).

Also adds explicit id indexes to elo_history, notifications, and
maintenance_logs. The ORM models declare `id = Column(Integer, primary_key=True,
index=True)` on these tables, but migrations 0011/0020/0021 only created the
PK (which SQLite auto-indexes implicitly). Add the explicit indexes so the
migration chain matches the ORM and the drift test passes.

Revision ID: 0023
Revises: 0022
Create Date: 2026-07-07
"""

from alembic import op
import sqlalchemy as sa


revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def _column_exists(conn, table, column):
    result = conn.execute(sa.text(f"PRAGMA table_info({table})"))
    return any(row[1] == column for row in result)


def _index_exists(conn, table, index):
    rows = conn.execute(sa.text(f"PRAGMA index_list({table})")).fetchall()
    return any(r[1] == index for r in rows)


def upgrade() -> None:
    conn = op.get_bind()
    for col in ("scan_filename", "scan_glb_filename", "scan_featured"):
        if _column_exists(conn, "games", col):
            op.execute(f"ALTER TABLE games DROP COLUMN {col}")

    # Add missing explicit id indexes to match ORM declarations.
    for table, index in (
        ("elo_history", "ix_elo_history_id"),
        ("notifications", "ix_notifications_id"),
        ("maintenance_logs", "ix_maintenance_logs_id"),
    ):
        if not _index_exists(conn, table, index):
            op.create_index(index, table, ["id"])


def downgrade() -> None:
    conn = op.get_bind()
    for table, index in (
        ("elo_history", "ix_elo_history_id"),
        ("notifications", "ix_notifications_id"),
        ("maintenance_logs", "ix_maintenance_logs_id"),
    ):
        if _index_exists(conn, table, index):
            op.drop_index(index, table_name=table)

    if not _column_exists(conn, "games", "scan_filename"):
        op.execute("ALTER TABLE games ADD COLUMN scan_filename TEXT")
    if not _column_exists(conn, "games", "scan_glb_filename"):
        op.execute("ALTER TABLE games ADD COLUMN scan_glb_filename VARCHAR(255)")
    if not _column_exists(conn, "games", "scan_featured"):
        op.execute(
            "ALTER TABLE games ADD COLUMN scan_featured BOOLEAN NOT NULL DEFAULT 0"
        )