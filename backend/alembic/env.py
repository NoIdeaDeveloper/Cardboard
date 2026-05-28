import os
import sys

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make sure the backend package is importable when running alembic from the
# backend/ directory (e.g. `cd backend && alembic upgrade head`).
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from database import Base
import models  # noqa: F401 — registers all ORM models with Base.metadata

config = context.config

# Override the sqlalchemy.url from the environment so Docker deployments work
# without editing alembic.ini.
config.set_main_option(
    "sqlalchemy.url",
    os.getenv("DATABASE_URL", "sqlite:///./data/cardboard.db"),
)

target_metadata = Base.metadata


def run_migrations_online() -> None:
    url = config.get_main_option("sqlalchemy.url") or ""
    connect_args = {"check_same_thread": False} if "sqlite" in url else {}
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args=connect_args,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # render_as_batch is required for SQLite: Alembic uses a
            # copy-alter strategy because SQLite does not support
            # ALTER COLUMN or DROP COLUMN directly.
            render_as_batch=True,
        )

        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
