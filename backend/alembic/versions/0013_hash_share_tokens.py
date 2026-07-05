"""Hash share tokens at rest

Share tokens were previously stored as plaintext in share_tokens.token
(primary key) and want_to_play_requests.token. This migration hashes all
existing tokens using SHA-256 so the raw token is only known at creation time.

Raw tokens from secrets.token_urlsafe(32) are ~43 chars of URL-safe base64.
SHA-256 hex digests are 64 chars. Both fit in the String(64) columns.

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-04
"""

import hashlib

from alembic import op
import sqlalchemy as sa


revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(sa.text("SELECT token FROM share_tokens")).fetchall()
    for (raw_token,) in rows:
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        bind.execute(
            sa.text("UPDATE share_tokens SET token = :hash WHERE token = :raw"),
            {"hash": token_hash, "raw": raw_token},
        )

    rows = bind.execute(
        sa.text("SELECT DISTINCT token FROM want_to_play_requests WHERE token IS NOT NULL")
    ).fetchall()
    for (raw_token,) in rows:
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        bind.execute(
            sa.text("UPDATE want_to_play_requests SET token = :hash WHERE token = :raw"),
            {"hash": token_hash, "raw": raw_token},
        )


def downgrade() -> None:
    pass
