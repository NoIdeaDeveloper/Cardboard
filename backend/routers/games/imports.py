"""Bulk import endpoints: BGG XML collection, BGG plays, and CSV."""
import csv
import io
import json
import logging
import xml.etree.ElementTree as ET

import defusedxml.ElementTree as DefusedET
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
import models
from constants import (
    BGG_IMPORT_MAX_BYTES, BGG_PLAYS_MAX_BYTES, CSV_IMPORT_MAX_BYTES, NOTES_MAX_LENGTH,
)
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
            if db.query(models.Game).filter(
                models.Game.name.ilike(name)
            ).first():
                results["skipped"] += 1
                continue

            # BGG object ID — extract early to skip duplicates before expensive parsing
            bgg_id = None
            try:
                bgg_id_str = item.get("objectid") or ""
                bgg_id = int(bgg_id_str) if bgg_id_str else None
            except (ValueError, TypeError):
                pass

            if bgg_id and db.query(models.Game).filter(models.Game.bgg_id == bgg_id).first():
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
            results["imported"] += 1

        except (AttributeError, ValueError, TypeError, KeyError, OSError) as exc:
            results["errors"].append(f"Skipped '{name or 'unknown'}': {type(exc).__name__}")
            logger.debug("BGG import row error for '%s': %s", row_name, exc)

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
    from routers.sessions import _sync_last_played

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

    for play in plays:
        game_name = ""
        try:
            item_el = play.find("item")
            if item_el is None:
                results["skipped"] += 1
                continue

            game_name = (item_el.get("name") or "").strip()
            bgg_object_id = item_el.get("objectid")

            # Match game by bgg_id first, then by name
            game = None
            if bgg_object_id:
                try:
                    game = db.query(models.Game).filter(models.Game.bgg_id == int(bgg_object_id)).first()
                except (ValueError, TypeError):
                    pass
            if not game and game_name:
                game = db.query(models.Game).filter(models.Game.name.ilike(game_name)).first()

            if not game:
                results["skipped"] += 1
                continue

            affected_game_ids.add(game.id)

            date_str = play.get("date", "")
            try:
                from datetime import date as date_cls
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

            existing_count = (
                db.query(func.count(models.PlaySession.id))
                .filter(
                    models.PlaySession.game_id == game.id,
                    models.PlaySession.played_at == played_at,
                )
                .scalar() or 0
            )
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

        except Exception as exc:
            results["errors"].append(f"Skipped '{game_name or 'unknown'}': {type(exc).__name__}")
            logger.debug("BGG plays import row error for '%s': %s", game_name, exc)

    db.flush()
    for gid in affected_game_ids:
        _sync_last_played(gid, db, commit=False)
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

    for row in reader:
        name = ""
        try:
            name = (row.get("name") or row.get("Name") or "").strip()
            if not name:
                results["skipped"] += 1
                continue

            if db.query(models.Game).filter(models.Game.name.ilike(name)).first():
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
