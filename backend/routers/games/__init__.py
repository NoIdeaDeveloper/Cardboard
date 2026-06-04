"""games router package.

The former monolithic games.py is split into focused submodules. They are
combined here in an order that preserves FastAPI path matching: the crud router
owns the `/{game_id}` catch-all routes and therefore must be registered LAST,
after every router that exposes a literal path under /api/games.
"""
from fastapi import APIRouter

from routers.games import backup, bgg, imports, recommend, crud

# Re-exported for external importers (routers.sharing, routers.stats) and for
# tests that reach into module internals.
from routers.games._common import (  # noqa: F401
    _heat_level, _load_tags, _attach_parent_name, build_game_responses, IMAGES_DIR,
)
from routers.games.bgg import _bgg_buckets  # noqa: F401
from routers.games.backup import _temp_backup_files, _cleanup_temp_backups  # noqa: F401

router = APIRouter()
router.include_router(backup.router)
router.include_router(bgg.router)
router.include_router(imports.router)
router.include_router(recommend.router)
router.include_router(crud.router)  # must be last — owns /{game_id}
