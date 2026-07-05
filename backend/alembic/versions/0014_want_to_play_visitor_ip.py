"""Add visitor_ip to want_to_play_requests

Stores the submitter's IP address for abuse investigation and per-IP rate
limiting. Existing rows get NULL (no backfill possible — IPs were never
captured).

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa

from sqlalchemy import inspect


revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


def _column_exists(table, column):
    conn = op.get_bind()
    cols = conn.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(c[1] == column for c in cols)


def upgrade() -> None:
    if not _column_exists('want_to_play_requests', 'visitor_ip'):
        op.add_column(
            'want_to_play_requests',
            sa.Column('visitor_ip', sa.String(64), nullable=True),
        )


def downgrade() -> None:
    if _column_exists('want_to_play_requests', 'visitor_ip'):
        op.drop_column('want_to_play_requests', 'visitor_ip')
