"""Bulk import endpoints: BGG XML collection, BGG plays, and CSV."""
import csv
import io
import json
import logging
import xml.etree.ElementTree as ET
from datetime import date as date_cls
from datetime import datetime, timezone

import defusedxml.ElementTree as DefusedET
import models
from constants import (
    BGG_IMPORT_MAX_BYTES,
    BGG_PLAYS_MAX_BYTES,
    CSV_IMPORT_MAX_BYTES,
    NOTES_MAX_LENGTH,
)
from database import get_db
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session
from utils import validate_url_safety

from routers.games._common import _save_tags

logger = logging.getLogger("cardboard.games")
router = APIRouter(prefix="/api/games", tags=["games"])


@router.post("/import/bgg")
async def import_bgg(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import a BoardGameGeek XML collection export (collectionlist format)."""
    content = await file.read(BGG_IMPORT_MAX_BYTES + 1)
    if len(content) > BGG_IMPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")

    try:
        root = DefusedET.fromstring(content)
    except ET.ParseError as exc:
        logger.warning("BGG XML import parse error: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid XML file")

    # BGG exports use <items> as root with <item> children, or <boardgames> with <boardgame>
    items = root.findall("item") or root.findall("boardgame")
    if not items:
        raise HTTPException(status_code=400, detail="No game items found in XML — is this a BGG collection export?")

    results = {"imported": 0, "skipped": 0, "errors": []}

    # Pre-load existing game names (lowercased) and bgg_ids into Python sets
    # to avoid per-row ilike/bg_id queries (N+1 fix).
    existing_names = {r[0].lower() for r in db.query(models.Game.name).all()}
    existing_bgg_ids = {
        r[0] for r in db.query(models.Game.bgg_id).filter(models.Game.bgg_id.isnot(None)).all()
    }

    for item in items:
        name = ""
        try:
            # Name: BGG exports have <name sortindex="1">Title</name>
            name_el = item.find("name[@sortindex='1']")
            if name_el is None:
                name_el = item.find("name")
            name = (name_el.text or "").strip() if name_el is not None else ""
            if not name:
                results["skipped"] += 1
                continue

            # Skip duplicates (case-insensitive by name)
            if name.lower() in existing_names:
                results["skipped"] += 1
                continue

            # BGG object ID — extract early to skip duplicates before expensive parsing
            bgg_id = None
            try:
                bgg_id_str = item.get("objectid") or ""
                bgg_id = int(bgg_id_str) if bgg_id_str else None
            except (ValueError, TypeError):
                pass

            if bgg_id and bgg_id in existing_bgg_ids:
                results["skipped"] += 1
                continue

            # Status
            status_el = item.find("status")
            status = "owned"
            if status_el is not None:
                if status_el.get("wishlist") == "1":
                    status = "wishlist"
                elif status_el.get("prevowned") == "1":
                    status = "sold"

            # Year
            year_text = item.findtext("yearpublished", "").strip()
            try:
                year = int(year_text) or None
            except ValueError:
                year = None
            if year is not None and not (1800 <= year <= 2099):
                year = None

            # Players / playtime from <stats> attributes
            stats_el = item.find("stats")
            def _int_attr(el, attr):
                if el is None:
                    return None
                try:
                    v = int(el.get(attr, "0") or "0")
                    return v if v > 0 else None
                except ValueError:
                    return None

            min_players  = _int_attr(stats_el, "minplayers")
            max_players  = _int_attr(stats_el, "maxplayers")
            min_playtime = _int_attr(stats_el, "minplaytime")
            max_playtime = _int_attr(stats_el, "maxplaytime")

            # User rating
            user_rating = None
            bgg_rating = None
            rating_el = item.find(".//stats/rating") if stats_el is not None else None
            if rating_el is not None:
                val = rating_el.get("value", "N/A")
                if val not in ("N/A", "0", ""):
                    try:
                        user_rating = round(min(10.0, max(1.0, float(val))), 1)
                    except ValueError:
                        pass
                # BGG community average
                avg_el = rating_el.find("average")
                if avg_el is not None:
                    try:
                        avg_val = float(avg_el.get("value", "0") or "0")
                        bgg_rating = round(min(10.0, max(1.0, avg_val)), 2) if avg_val > 0 else None
                    except (ValueError, TypeError):
                        pass

            # Notes / comment
            notes = (item.findtext("comment") or "").strip() or None

            # Image URL
            image_url = (item.findtext("image") or "").strip()
            if image_url.startswith("//"):
                image_url = "https:" + image_url
            image_url = image_url or None
            if image_url:
                # Never persist URLs pointing at internal/private hosts — the
                # URL is served back to browsers (collection view, share page,
                # export), so validate before storing, not only at cache time.
                is_valid, _err = validate_url_safety(image_url)
                if not is_valid:
                    logger.warning("BGG import image URL rejected for %r: %s", name, _err)
                    image_url = None

            game = models.Game(
                name=name,
                status=status,
                year_published=year,
                min_players=min_players,
                max_players=max_players,
                min_playtime=min_playtime,
                max_playtime=max_playtime,
                user_rating=user_rating,
                bgg_id=bgg_id,
                bgg_rating=bgg_rating,
                user_notes=notes,
                image_url=image_url,
            )
            db.add(game)
            existing_names.add(name.lower())
            if bgg_id:
                existing_bgg_ids.add(bgg_id)
            results["imported"] += 1

        except (AttributeError, ValueError, TypeError, KeyError, OSError) as exc:
            results["errors"].append(f"Skipped '{name or 'unknown'}': {type(exc).__name__}")
            logger.debug("BGG import row error for '%s': %s", name, exc)

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("BGG import commit failed: %s", exc)
        results["imported"] = 0
        results["errors"].append("Database commit failed — no games were saved")
    logger.info("BGG import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
    return results

@router.post("/import/bgg-plays")
async def import_bgg_plays(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import play history from a BGG plays XML export."""
    content = await file.read(BGG_PLAYS_MAX_BYTES + 1)
    if len(content) > BGG_PLAYS_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    try:
        root = DefusedET.fromstring(content)
    except ET.ParseError as exc:
        logger.warning("BGG plays XML import parse error: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid XML file")

    plays = root.findall("play")
    if not plays:
        raise HTTPException(status_code=400, detail="No play records found — is this a BGG plays export?")

    results = {"imported": 0, "skipped": 0, "errors": []}
    affected_game_ids = set()

    # Pre-load all games into dicts keyed by bgg_id and lowercased name (N+1 fix).
    games_by_bgg_id: dict[int, models.Game] = {}
    games_by_name: dict[str, models.Game] = {}
    games_by_id: dict[int, models.Game] = {}
    for g in db.query(models.Game).all():
        games_by_id[g.id] = g
        if g.bgg_id is not None:
            games_by_bgg_id[g.bgg_id] = g
        if g.name:
            games_by_name[g.name.lower()] = g

    # Pre-load existing (game_id, played_at) counts so dedupe is one query
    # instead of one per <play> row.
    existing_pairs: dict[tuple[int, date_cls], int] = {}
    for gid, played in db.query(models.PlaySession.game_id, models.PlaySession.played_at).all():
        key = (gid, played)
        existing_pairs[key] = existing_pairs.get(key, 0) + 1

    for play in plays:
        game_name = ""
        try:
            item_el = play.find("item")
            if item_el is None:
                results["skipped"] += 1
                continue

            game_name = (item_el.get("name") or "").strip()
            bgg_object_id = item_el.get("objectid")

            # Match game by bgg_id first, then by name (using pre-loaded dicts)
            game = None
            if bgg_object_id:
                try:
                    game = games_by_bgg_id.get(int(bgg_object_id))
                except (ValueError, TypeError):
                    pass
            if not game and game_name:
                game = games_by_name.get(game_name.lower())

            if not game:
                results["skipped"] += 1
                continue

            affected_game_ids.add(game.id)

            date_str = play.get("date", "")
            try:
                played_at = date_cls.fromisoformat(date_str)
            except (ValueError, TypeError):
                results["skipped"] += 1
                continue

            quantity = min(int(play.get("quantity", "1") or "1"), 50)
            player_count = None
            players_el = play.find("players")
            if players_el is not None:
                player_count = len(players_el.findall("player")) or None

            duration = None
            try:
                dur = int(play.get("length", "0") or "0")
                duration = dur if dur > 0 else None
            except (ValueError, TypeError):
                pass

            comment = (play.findtext("comments") or "").strip() or None

            existing_count = existing_pairs.get((game.id, played_at), 0)
            for i in range(quantity):
                if i < existing_count:
                    results["skipped"] += 1
                    continue
                db_session = models.PlaySession(
                    game_id=game.id,
                    played_at=played_at,
                    player_count=player_count,
                    duration_minutes=duration,
                    notes=comment,
                )
                db.add(db_session)
                results["imported"] += 1
                # Newly-added plays extend the dedupe map so duplicate rows
                # later in the same file don't import twice.
                key = (game.id, played_at)
                existing_pairs[key] = existing_pairs.get(key, 0) + 1

        except Exception as exc:
            results["errors"].append(f"Skipped '{game_name or 'unknown'}': {type(exc).__name__}")
            logger.debug("BGG plays import row error for '%s': %s", game_name, exc)

    db.flush()
    # Batch-recompute last_played for every affected game in a single grouped
    # query instead of one MAX(played_at) + fetch per game.
    if affected_game_ids:
        latest_rows = (
            db.query(
                models.PlaySession.game_id,
                func.max(models.PlaySession.played_at),
            )
            .filter(models.PlaySession.game_id.in_(affected_game_ids))
            .group_by(models.PlaySession.game_id)
            .all()
        )
        latest_by_game = dict(latest_rows)
        for gid in affected_game_ids:
            game = games_by_id.get(gid)
            if game:
                game.last_played = latest_by_game.get(gid)
                game.date_modified = datetime.now(timezone.utc)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("BGG plays import commit failed: %s", exc)
        results["errors"].append("Database commit failed — no plays were saved")
        logger.info("BGG plays import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
        return results

    logger.info("BGG plays import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
    return results

@router.post("/import/csv")
async def import_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import games from a CSV file. Columns: name, status, user_rating, notes, labels, categories, mechanics."""
    content = await file.read(CSV_IMPORT_MAX_BYTES + 1)
    if len(content) > CSV_IMPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 5 MB)")

    try:
        text_content = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text_content))
    except Exception as exc:
        logger.warning("CSV import parse error: %s", exc)
        raise HTTPException(status_code=400, detail="Could not parse CSV file")

    results = {"imported": 0, "skipped": 0, "errors": []}

    VALID_STATUSES = {"owned", "wishlist", "sold"}

    # Pre-load existing game names (lowercased) into a Python set (N+1 fix).
    existing_names = {r[0].lower() for r in db.query(models.Game.name).all()}

    for row in reader:
        name = ""
        try:
            name = (row.get("name") or row.get("Name") or "").strip()
            if not name:
                results["skipped"] += 1
                continue

            if name.lower() in existing_names:
                results["skipped"] += 1
                continue

            status_raw = (row.get("status") or row.get("Status") or "owned").strip().lower()
            status = status_raw if status_raw in VALID_STATUSES else "owned"

            user_rating = None
            rating_raw = (row.get("user_rating") or row.get("rating") or "").strip()
            if rating_raw:
                try:
                    user_rating = round(min(10.0, max(1.0, float(rating_raw))), 1)
                except ValueError:
                    pass

            notes_raw = (row.get("notes") or row.get("comment") or "").strip()
            notes = notes_raw[:NOTES_MAX_LENGTH] if notes_raw else None

            def _csv_to_json(val):
                val = (val or "").strip()
                if not val:
                    return None
                items = [x.strip() for x in val.split(";") if x.strip()]
                return json.dumps(items) if items else None

            categories = _csv_to_json(row.get("categories") or row.get("Categories"))
            mechanics = _csv_to_json(row.get("mechanics") or row.get("Mechanics"))
            labels = _csv_to_json(row.get("labels") or row.get("Labels"))

            # DB operations inside a savepoint so a row failure doesn't break the batch
            savepoint = db.begin_nested()
            try:
                game = models.Game(
                    name=name,
                    status=status,
                    user_rating=user_rating,
                    user_notes=notes,
                )
                db.add(game)
                db.flush()

                tag_data = {}
                if categories:
                    tag_data["categories"] = categories
                if mechanics:
                    tag_data["mechanics"] = mechanics
                if labels:
                    tag_data["labels"] = labels
                if tag_data:
                    _save_tags(game.id, tag_data, db)

                savepoint.commit()
                existing_names.add(name.lower())
                results["imported"] += 1
            except Exception:
                savepoint.rollback()
                raise

        except HTTPException as http_exc:
            results["errors"].append(f"Row '{name}': {http_exc.detail}")
        except Exception as exc:
            logger.debug("CSV import row error for '%s': %s", name, exc)
            results["errors"].append(f"Row '{name}': {type(exc).__name__}")

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("CSV import commit failed: %s", exc)
        results["errors"].append("Database commit failed — no games were saved")
        results["imported"] = 0
    logger.info("CSV import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
    return results
