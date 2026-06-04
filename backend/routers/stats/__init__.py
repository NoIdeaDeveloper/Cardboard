"""stats router package.

Split from the former monolithic stats.py into one module per endpoint. All
routes share the /api prefix and are literal paths (no /{id} catch-alls), so
include order is not significant for path matching.
"""
from fastapi import APIRouter

from routers.stats import dashboard, collection, recommend, trade_sell

router = APIRouter()
router.include_router(dashboard.router)
router.include_router(collection.router)
router.include_router(recommend.router)
router.include_router(trade_sell.router)
