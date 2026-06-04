"""Live BoardGameGeek API interactions: search, fetch, metadata refresh.

Includes the per-IP token-bucket rate limiter shared by the BGG-facing GET
endpoints.
"""
import json
import logging
import ssl
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import threading as _threading
import collections as _collections
from typing import Optional

import certifi
import defusedxml.ElementTree as DefusedET
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils import get_game_or_404, build_safe_opener
from routers.games._common import (
    _save_tags, _load_tags, _cache_game_image, _attach_parent_name,
)

logger = logging.getLogger("cardboard.games")
router = APIRouter(prefix="/api/games", tags=["games"])

# ----- BGG rate limiter — token bucket, 10 requests / minute per IP -----
_BGG_RATE_LIMIT = 10          # requests
_BGG_RATE_WINDOW = 60.0       # seconds
_bgg_buckets: dict[str, list[float]] = _collections.defaultdict(list)
_bgg_lock = _threading.Lock()

_bgg_ssl_ctx = ssl.create_default_context(cafile=certifi.where())
_safe_opener_ssl = build_safe_opener(context=_bgg_ssl_ctx)

BGG_API_URL = "https://boardgamegeek.com/xmlapi2/thing?id={bgg_id}&stats=1"
BGG_SEARCH_URL = "https://boardgamegeek.com/xmlapi2/search?query={query}&type=boardgame&exact=1"


def _check_bgg_rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    cutoff = now - _BGG_RATE_WINDOW
    with _bgg_lock:
        # Evict old timestamps for this IP
        timestamps = _bgg_buckets[ip]
        _bgg_buckets[ip] = [t for t in timestamps if t > cutoff]
        if len(_bgg_buckets[ip]) >= _BGG_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many BGG requests — please wait a moment")
        _bgg_buckets[ip].append(now)
        if len(_bgg_buckets) > 50:
            stale = [k for k, v in _bgg_buckets.items() if not v]
            for k in stale:
                del _bgg_buckets[k]

def _fetch_bgg_thing(bgg_id: int) -> Optional[ET.Element]:
    """Fetch BGG XML for a thing ID. Returns the <item> element or None.

    BGG returns HTTP 202 when the request is queued for processing — retries
    up to 3 times with a 2-second delay before giving up.
    """
    url = BGG_API_URL.format(bgg_id=bgg_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Cardboard/1.0"})
        content = None
        for attempt in range(3):
            with _safe_opener_ssl.open(req, timeout=15) as resp:
                if resp.status == 202:
                    logger.info("BGG returned 202 for id=%d, retry %d/3", bgg_id, attempt + 1)
                    time.sleep(2)
                    continue
                content = resp.read(5 * 1024 * 1024)
                break
        if content is None:
            logger.warning("BGG fetch gave up after 3 x 202 for id=%d", bgg_id)
            return None
        root = DefusedET.fromstring(content)
        return root.find("item")
    except Exception as exc:
        logger.warning("BGG fetch failed for id=%d: %s", bgg_id, exc)
        return None

def _parse_bgg_item(item: ET.Element) -> dict:
    """Extract game fields from a BGG <item> element."""
    def _int_val(tag, attr="value"):
        el = item.find(tag)
        if el is None:
            return None
        try:
            v = int(el.get(attr, "0") or el.text or "0")
            return v if v > 0 else None
        except (ValueError, TypeError):
            return None

    def _float_val(tag, attr="value"):
        el = item.find(tag)
        if el is None:
            return None
        try:
            return float(el.get(attr) or el.text or "0")
        except (ValueError, TypeError):
            return None

    # Primary name
    name_el = item.find("name[@type='primary']") or item.find("name")
    name = name_el.get("value", "").strip() if name_el is not None else ""

    # Description
    desc_el = item.find("description")
    description = (desc_el.text or "").strip()[:5000] if desc_el is not None else None

    # Year
    year = _int_val("yearpublished")

    # Players / playtime / difficulty
    min_players = _int_val("minplayers")
    max_players = _int_val("maxplayers")
    min_playtime = _int_val("minplaytime")
    max_playtime = _int_val("maxplaytime")

    difficulty = None
    weight_el = item.find(".//averageweight")
    if weight_el is not None:
        try:
            w = float(weight_el.get("value", "0"))
            difficulty = round(min(5.0, max(1.0, w)), 2) if w > 0 else None
        except (ValueError, TypeError):
            pass

    # BGG community rating
    bgg_rating = None
    avg_el = item.find(".//average")
    if avg_el is not None:
        try:
            r = float(avg_el.get("value", "0"))
            bgg_rating = round(min(10.0, max(1.0, r)), 2) if r > 0 else None
        except (ValueError, TypeError):
            pass

    # Tags
    def _links(link_type):
        return json.dumps([el.get("value", "") for el in item.findall(f"link[@type='{link_type}']") if el.get("value")])

    categories = _links("boardgamecategory")
    mechanics = _links("boardgamemechanic")
    designers = _links("boardgamedesigner")
    publishers = _links("boardgamepublisher")

    # Image
    img_el = item.find("image")
    image_url = (img_el.text or "").strip() if img_el is not None else None
    if image_url and image_url.startswith("//"):
        image_url = "https:" + image_url

    return {
        "name": name,
        "description": description,
        "year_published": year,
        "min_players": min_players,
        "max_players": max_players,
        "min_playtime": min_playtime,
        "max_playtime": max_playtime,
        "difficulty": difficulty,
        "bgg_rating": bgg_rating,
        "categories": categories,
        "mechanics": mechanics,
        "designers": designers,
        "publishers": publishers,
        "image_url": image_url,
    }

@router.get("/bgg-search")
def bgg_search(request: Request, q: str = Query(..., min_length=1, max_length=200)):
    _check_bgg_rate_limit(request)
    """Search BGG for boardgames matching the query string."""
    url = f"https://boardgamegeek.com/xmlapi2/search?query={urllib.parse.quote(q)}&type=boardgame"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Cardboard/1.0"})
        with _safe_opener_ssl.open(req, timeout=10) as resp:
            content = resp.read(2 * 1024 * 1024)
        root = DefusedET.fromstring(content)
        results = []
        for item in root.findall("item")[:8]:
            bgg_id = int(item.get("id", 0))
            name_el = item.find("name[@type='primary']") or item.find("name")
            name = name_el.get("value", "").strip() if name_el is not None else ""
            year_el = item.find("yearpublished")
            year = year_el.get("value") if year_el is not None else None
            thumb_val = item.get("thumbnail") or item.findtext("thumbnail")
            thumbnail = ("https:" + thumb_val) if thumb_val and thumb_val.startswith("//") else thumb_val
            if bgg_id and name:
                results.append({"bgg_id": bgg_id, "name": name, "year_published": int(year) if year else None, "thumbnail": thumbnail})
        return results
    except Exception as exc:
        logger.warning("BGG search failed (%s): %s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="BGG search temporarily unavailable")

@router.get("/bgg-fetch/{bgg_id}")
def bgg_fetch(request: Request, bgg_id: int):
    _check_bgg_rate_limit(request)
    """Fetch full BGG metadata for a given BGG ID and return as game fields."""
    item = _fetch_bgg_thing(bgg_id)
    if item is None:
        raise HTTPException(status_code=502, detail="Failed to fetch from BGG")
    data = _parse_bgg_item(item)
    data["bgg_id"] = bgg_id
    return data

@router.post("/{game_id}/refresh-bgg", response_model=schemas.GameResponse)
def refresh_from_bgg(
    game_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Re-fetch metadata from BGG and update the game record."""
    db_game = get_game_or_404(game_id, db)
    if not db_game.bgg_id:
        raise HTTPException(status_code=400, detail="Game has no BGG ID — add it manually first")

    item = _fetch_bgg_thing(db_game.bgg_id)
    if item is None:
        raise HTTPException(status_code=502, detail="Could not fetch data from BoardGameGeek")

    data = _parse_bgg_item(item)
    tag_data = {k: data.pop(k) for k in ["categories", "mechanics", "designers", "publishers"]}

    for field, value in data.items():
        if value is not None:
            setattr(db_game, field, value)

    db.flush()
    _save_tags(game_id, tag_data, db)
    db.commit()
    db.refresh(db_game)
    _load_tags([db_game], db)

    new_image = db_game.image_url
    if new_image and not new_image.startswith("/api/"):
        background_tasks.add_task(_cache_game_image, game_id, new_image)

    logger.info("BGG refresh: game_id=%d bgg_id=%d", game_id, db_game.bgg_id)
    return _attach_parent_name(db_game, db)
