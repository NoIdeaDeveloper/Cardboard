"""Backup, restore, and export (ZIP / JSON / CSV / PDF / static HTML)."""
import atexit
import base64
import csv
import glob
import io
import json
import logging
import os
import re
import sqlite3
import tempfile
import zipfile
from datetime import date as _date, datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from database import get_db, engine
import models
import schemas
from utils import safe_delete_file, validate_file_extension
from constants import FRONTEND_PATH
from routers.games._common import IMAGES_DIR, build_game_responses, _safe_header_filename

logger = logging.getLogger("cardboard.games")
router = APIRouter(prefix="/api/games", tags=["games"])


# Track temporary backup files so they are cleaned up on shutdown even if the
# background task that normally removes them never runs (e.g. server crash).
_temp_backup_files: set[str] = set()

def _cleanup_temp_backups():
    for path in list(_temp_backup_files):
        safe_delete_file(path)
    _temp_backup_files.clear()

atexit.register(_cleanup_temp_backups)

@router.get("/backup")
def download_backup(background_tasks: BackgroundTasks):
    """
    Create a ZIP backup of the database and media files (images, instructions, gallery).
    The ZIP is streamed directly — nothing is persisted to disk permanently.
    """
    data_dir = os.getenv("DATA_DIR", "/app/data")
    db_url = os.getenv("DATABASE_URL", "sqlite:///./data/cardboard.db")

    # Strip SQLite URL prefix to get the file path
    db_path = db_url.replace("sqlite+aiosqlite:///", "").replace("sqlite:///", "")
    if not os.path.isabs(db_path):
        db_path = os.path.join("/app", db_path)

    if not os.path.isfile(db_path):
        raise HTTPException(status_code=500, detail="Database file not found")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    zip_filename = f"cardboard-backup-{ts}.zip"

    # Write to a named temp file so FileResponse can seek/stat it
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    _temp_backup_files.add(tmp.name)

    # Use SQLite backup API — safe with active connections
    db_tmp = tmp.name + ".db"
    try:
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(db_tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()

        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(db_tmp, "cardboard.db")
            for subdir in ["images", "instructions", "gallery", "avatars"]:
                dir_path = os.path.join(data_dir, subdir)
                for f in glob.glob(os.path.join(dir_path, "**"), recursive=True):
                    if os.path.isfile(f):
                        zf.write(f, os.path.relpath(f, data_dir))
    finally:
        if os.path.exists(db_tmp):
            os.remove(db_tmp)

    size_mb = round(os.path.getsize(tmp.name) / 1_048_576, 1)
    logger.info("Backup created: %s (%.1f MB)", zip_filename, size_mb)

    try:
        response = FileResponse(
            tmp.name,
            media_type="application/zip",
            filename=zip_filename,
        )
    except Exception:
        safe_delete_file(tmp.name)
        _temp_backup_files.discard(tmp.name)
        raise
    background_tasks.add_task(os.remove, tmp.name)
    background_tasks.add_task(_temp_backup_files.discard, tmp.name)
    return response

@router.get("/backup/json")
def download_json_backup(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Export all games and sessions as JSON inside a ZIP (human-readable backup)."""
    data_dir = os.getenv("DATA_DIR", "/app/data")
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    zip_filename = f"cardboard-json-backup-{ts}.zip"

    games = db.query(models.Game).all()
    sessions = db.query(models.PlaySession).all()
    session_players = db.query(models.SessionPlayer, models.Player.name).join(
        models.Player, models.Player.id == models.SessionPlayer.player_id
    ).all()

    # Build player names by session
    players_by_session = {}
    for sp, name in session_players:
        players_by_session.setdefault(sp.session_id, []).append(name)

    games_data = [
        {k: v for k, v in g.__dict__.items() if not k.startswith('_')}
        for g in games
    ]
    sessions_data = [
        {
            **{k: v for k, v in s.__dict__.items() if not k.startswith('_')},
            "players": players_by_session.get(s.id, []),
        }
        for s in sessions
    ]

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    _temp_backup_files.add(tmp.name)
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("games.json", json.dumps(games_data, default=str, indent=2))
            zf.writestr("sessions.json", json.dumps(sessions_data, default=str, indent=2))
            for subdir in ["images", "gallery"]:
                dir_path = os.path.join(data_dir, subdir)
                for f_path in glob.glob(os.path.join(dir_path, "**"), recursive=True):
                    if os.path.isfile(f_path):
                        zf.write(f_path, os.path.join("media", os.path.relpath(f_path, data_dir)))
    except Exception as exc:
        safe_delete_file(tmp.name)
        _temp_backup_files.discard(tmp.name)
        logger.error("JSON backup failed: %s", exc)
        raise HTTPException(status_code=500, detail="Backup failed. Check server logs for details.")

    logger.info("JSON backup created: %s", zip_filename)

    try:
        response = FileResponse(
            tmp.name,
            media_type="application/zip",
            filename=zip_filename,
        )
    except Exception:
        safe_delete_file(tmp.name)
        raise
    background_tasks.add_task(os.remove, tmp.name)
    background_tasks.add_task(_temp_backup_files.discard, tmp.name)
    return response

@router.get("/export/static-html")
def export_static_html(db: Session = Depends(get_db)):
    """
    Export the collection as a self-contained static HTML page.
    CSS, shared-utils.js, and game data are all inlined so the file works
    when opened directly from disk with no server.
    Only games with share_hidden=False are included.
    """
    # ── 1. Query games ────────────────────────────────────────────────────────
    games = db.query(models.Game).filter(models.Game.share_hidden == False).all()
    results = build_game_responses(games, db)
    games_json = [r.model_dump(mode="json") for r in results]

    _MIME_MAP = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                 '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'}

    for game_data in games_json:
        game_id = game_data.get('id')
        if game_data.get('image_cached') and game_data.get('image_ext'):
            image_path = os.path.join(IMAGES_DIR, f"{game_id}{game_data['image_ext']}")
            if os.path.isfile(image_path):
                try:
                    with open(image_path, 'rb') as fh:
                        b64 = base64.b64encode(fh.read()).decode('ascii')
                    mime = _MIME_MAP.get(game_data['image_ext'].lower(), 'image/jpeg')
                    game_data['image_url'] = f"data:{mime};base64,{b64}"
                except Exception as exc:
                    logger.warning("Failed to embed image for game %s: %s", game_id, exc)
                    game_data['image_url'] = None
            else:
                game_data['image_url'] = None
        # Any remaining /api/ URL is a server-relative path that won't work offline
        elif (game_data.get('image_url') or '').startswith('/api/'):
            game_data['image_url'] = None
        game_data.pop('image_cached', None)
        game_data.pop('image_ext', None)
        game_data.pop('image_cache_status', None)

    # ── 2. Read share.html template ───────────────────────────────────────────
    share_html_path = os.path.join(FRONTEND_PATH, "share.html")
    if not os.path.isfile(share_html_path):
        raise HTTPException(status_code=500, detail="share.html template not found")
    with open(share_html_path, 'r', encoding='utf-8') as fh:
        html = fh.read()

    # ── 3. Inline CSS (replace <link href="/css/style.css">) ─────────────────
    css_path = os.path.join(FRONTEND_PATH, "css", "style.css")
    if os.path.isfile(css_path):
        with open(css_path, 'r', encoding='utf-8') as fh:
            css_content = fh.read()
        html = html.replace(
            '<link rel="stylesheet" href="/css/style.css" />',
            f'<style>\n{css_content}\n</style>',
            1,
        )

    # ── 4. Inline shared-utils.js AND inject data variable ───────────────────
    # The data variable must be defined before the main <script> block that
    # reads window.__STATIC_COLLECTION__ at line 2 of that block.
    utils_path = os.path.join(FRONTEND_PATH, "js", "shared-utils.js")
    json_payload = json.dumps(games_json, separators=(',', ':'))
    # Prevent </script> in any string value from breaking out of the script block
    json_payload = json_payload.replace('</', '<\\/')
    data_assignment = f'window.__STATIC_COLLECTION__ = {json_payload};'
    if os.path.isfile(utils_path):
        with open(utils_path, 'r', encoding='utf-8') as fh:
            utils_content = fh.read()
        # Replace external script tag with inlined content + data variable
        inline_block = f'<script>\n{utils_content}\n{data_assignment}\n</script>'
        html = html.replace('<script src="/js/shared-utils.js"></script>', inline_block, 1)
    else:
        # Fallback: inject data variable before the main script block
        html = html.replace(
            '<script src="/js/shared-utils.js"></script>',
            f'<script>{data_assignment}</script>',
            1,
        )

    # ── 4b. Inline theme-init.js and share.js ────────────────────────────────
    # In the served page these are external (CSP-clean); for the offline export
    # there is no server, so fold them back inline. Only the literal "</script"
    # sequence needs escaping to avoid prematurely closing the block.
    for fname in ("theme-init.js", "share.js"):
        fpath = os.path.join(FRONTEND_PATH, "js", fname)
        tag = f'<script src="/js/{fname}"></script>'
        if os.path.isfile(fpath):
            with open(fpath, "r", encoding="utf-8") as fh:
                content = fh.read().replace("</script", "<\\/script")
            html = html.replace(tag, f"<script>\n{content}\n</script>", 1)
        else:
            html = html.replace(tag, "", 1)

    # ── 5. Remove absolute-path references that break offline use ─────────────
    # Favicon — just drop it; no functional impact
    html = html.replace('<link rel="icon" type="image/png" href="/cardboard-icon.png" />', '', 1)

    # Logo icon — embed as base64 if available, otherwise remove the <img>
    icon_path = os.path.join(FRONTEND_PATH, "cardboard-icon.png")
    if os.path.isfile(icon_path):
        with open(icon_path, 'rb') as fh:
            icon_b64 = base64.b64encode(fh.read()).decode('ascii')
        html = html.replace(
            'src="/cardboard-icon.png"',
            f'src="data:image/png;base64,{icon_b64}"',
        )
    else:
        html = html.replace('<img class="logo-icon" src="/cardboard-icon.png" alt="Cardboard" />', '', 1)

    # ── 6. Return as download ─────────────────────────────────────────────────
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-collection-{ts}.html"
    return Response(
        content=html,
        media_type="text/html",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )

@router.get("/export/pdf")
def export_pdf(db: Session = Depends(get_db)):
    """
    Export the collection as a PDF with cover image, title, description,
    difficulty, playtime, and player count for each game.
    Only games with share_hidden=False are included.
    """
    from html import escape as _html_escape, unescape as _html_unescape
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Image as RLImage,
        Table, TableStyle, HRFlowable, KeepTogether,
    )

    def _safe(text: str) -> str:
        """Strip HTML tags, collapse whitespace, then XML-escape for reportlab Paragraph."""
        text = _html_unescape(text)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return _html_escape(text)

    games = db.query(models.Game).filter(models.Game.share_hidden == False).all()
    results = build_game_responses(games, db)

    buffer = io.BytesIO()
    PAGE_W, _ = letter
    MARGIN = 0.75 * inch
    IMG_W = 1.25 * inch
    IMG_H = 1.5 * inch        # portrait-friendly; most board game covers are taller than wide
    IMG_COL_W = IMG_W + 0.15 * inch  # image column width, gap between image and text
    TEXT_COL_W = PAGE_W - 2 * MARGIN - IMG_COL_W

    # Brand colours — warm palette matching the web app
    C_HEADING = colors.HexColor("#2b1d0e")
    C_SUB     = colors.HexColor("#8a7055")
    C_ACCENT  = colors.HexColor("#c9a84c")
    C_TITLE   = colors.HexColor("#2b1d0e")
    C_META    = colors.HexColor("#5c4535")
    C_DESC    = colors.HexColor("#3c2e22")
    C_DIVIDER = colors.HexColor("#e0c898")

    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
    )

    styles = getSampleStyleSheet()
    heading_style = ParagraphStyle(
        "CollHeading",
        parent=styles["Normal"],
        fontSize=22,
        leading=28,
        fontName="Times-Bold",   # closest PDF-standard serif to the app's Playfair Display
        textColor=C_HEADING,
        alignment=1,
        spaceAfter=4,
    )
    sub_style = ParagraphStyle(
        "CollSub",
        parent=styles["Normal"],
        fontSize=9,
        leading=13,
        fontName="Helvetica",
        textColor=C_SUB,
        alignment=1,
        spaceAfter=16,
    )
    title_style = ParagraphStyle(
        "GameTitle",
        parent=styles["Normal"],
        fontSize=13,
        leading=17,
        fontName="Times-Bold",
        textColor=C_TITLE,
        spaceAfter=3,
    )
    meta_style = ParagraphStyle(
        "GameMeta",
        parent=styles["Normal"],
        fontSize=8,
        leading=11,
        fontName="Helvetica",
        textColor=C_META,
        spaceAfter=5,
    )
    desc_style = ParagraphStyle(
        "GameDesc",
        parent=styles["Normal"],
        fontSize=8,
        leading=12,
        fontName="Helvetica",
        textColor=C_DESC,
    )

    def difficulty_label(d):
        if d is None:
            return None
        if d <= 1.5:
            label = "Very Easy"
        elif d <= 2.5:
            label = "Easy"
        elif d <= 3.5:
            label = "Medium"
        elif d <= 4.5:
            label = "Hard"
        else:
            label = "Very Hard"
        return f"{d:.1f}/5 ({label})"

    def load_cover(game):
        """Load a cached cover image and scale it to fit IMG_W × IMG_H preserving aspect ratio.

        Mirrors the fallback logic in GET /{game_id}/image: if image_ext is not stored
        (records cached before that column was introduced), glob for any file matching
        {game_id}.* so those images are not silently skipped.
        """
        try:
            if game.image_cached:
                # Primary path — extension is known
                if game.image_ext:
                    path = os.path.join(IMAGES_DIR, f"{game.id}{game.image_ext}")
                else:
                    # Fallback for legacy records where image_ext was not yet stored
                    matches = glob.glob(os.path.join(IMAGES_DIR, f"{game.id}.*"))
                    path = matches[0] if matches else None

                if path and os.path.isfile(path):
                    img = RLImage(path)
                    iw, ih = img.imageWidth, img.imageHeight
                    if iw > 0 and ih > 0:
                        scale = min(IMG_W / iw, IMG_H / ih)
                        img.drawWidth = iw * scale
                        img.drawHeight = ih * scale
                    else:
                        img.drawWidth = IMG_W
                        img.drawHeight = IMG_H
                    img.hAlign = "CENTER"
                    return img
        except Exception as exc:
            logger.warning("PDF: image load failed for game %s: %s", game.id, exc)
        return None

    story = []

    ts_display = _date.today().strftime("%B %d, %Y")
    story.append(Paragraph("Board Game Collection", heading_style))
    story.append(Paragraph(f"Generated {ts_display} · {len(results)} games", sub_style))
    story.append(HRFlowable(width="100%", thickness=2, color=C_DIVIDER, spaceAfter=10))

    GOLD = "#c9a84c"

    for game in results:
        meta_parts = []

        if game.min_players and game.max_players:
            val = str(game.min_players) if game.min_players == game.max_players else f"{game.min_players}–{game.max_players}"
            meta_parts.append(f'<font color="{GOLD}">Players</font> {val}')
        elif game.min_players:
            meta_parts.append(f'<font color="{GOLD}">Players</font> {game.min_players}+')

        if game.min_playtime and game.max_playtime:
            val = f"{game.min_playtime} min" if game.min_playtime == game.max_playtime else f"{game.min_playtime}–{game.max_playtime} min"
            meta_parts.append(f'<font color="{GOLD}">Time</font> {val}')
        elif game.min_playtime:
            meta_parts.append(f'<font color="{GOLD}">Time</font> {game.min_playtime}+ min')

        diff = difficulty_label(game.difficulty)
        if diff:
            meta_parts.append(f'<font color="{GOLD}">Difficulty</font> {diff}')

        desc = (game.description or "").strip()

        text_cells = [Paragraph(_safe(game.name), title_style)]
        if meta_parts:
            text_cells.append(Paragraph("  ·  ".join(meta_parts), meta_style))
        if desc:
            text_cells.append(Paragraph(_safe(desc), desc_style))

        cover = load_cover(game)
        if cover:
            row = [[cover, text_cells]]
            col_widths = [IMG_COL_W, TEXT_COL_W]
        else:
            row = [[text_cells]]
            col_widths = [PAGE_W - 2 * MARGIN]

        tbl = Table(row, colWidths=col_widths)
        tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ("ALIGN", (0, 0), (0, 0), "CENTER"),
        ]))

        story.append(KeepTogether([tbl, Spacer(1, 6)]))
        story.append(HRFlowable(width="100%", thickness=0.5, color=C_DIVIDER, spaceAfter=8))

    doc.build(story)
    buffer.seek(0)

    filename = f"cardboard-collection-{_date.today().strftime('%Y-%m-%d')}.pdf"
    return Response(
        content=buffer.read(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )

@router.get("/export/json")
def export_json(db: Session = Depends(get_db)):
    """Export the full collection, sessions, and players as a JSON download."""
    games = db.query(models.Game).all()
    game_results = build_game_responses(games, db)
    sessions = db.query(models.PlaySession).all()
    # Pre-load all session-player rows with a single JOIN to avoid N+1 queries
    # and attribute access on non-existent ORM relationships.
    sp_rows = (
        db.query(models.SessionPlayer, models.Player)
        .join(models.Player, models.Player.id == models.SessionPlayer.player_id)
        .all()
    )
    sp_map: dict[int, list[dict]] = {}
    for sp, player in sp_rows:
        sp_map.setdefault(sp.session_id, []).append({"name": player.name, "score": sp.score})
    session_rows = []
    for s in sessions:
        d = schemas.PlaySessionResponse.model_validate(s).model_dump(mode="json")
        d["players"] = sp_map.get(s.id, [])
        session_rows.append(d)
    players = db.query(models.Player).all()
    player_rows = [schemas.PlayerResponse.model_validate(p).model_dump(mode="json") for p in players]
    payload = {
        "export_date": datetime.now(timezone.utc).isoformat(),
        "version": "1.0",
        "games": [r.model_dump(mode="json") for r in game_results],
        "sessions": session_rows,
        "players": player_rows,
    }
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-export-{ts}.json"
    return Response(
        content=json.dumps(payload, default=str, indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )

@router.get("/export/csv")
def export_csv(db: Session = Depends(get_db)):
    """Export the full collection as a CSV download."""
    games = db.query(models.Game).all()
    results = build_game_responses(games, db)
    fields = ["name", "status", "year_published", "min_players", "max_players",
              "min_playtime", "max_playtime", "difficulty", "user_rating",
              "bgg_id", "bgg_rating", "purchase_price", "purchase_date",
              "purchase_location", "location", "condition", "edition",
              "last_played", "categories", "mechanics", "designers",
              "publishers", "labels", "user_notes"]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction='ignore')
    writer.writeheader()
    for r in results:
        row = r.model_dump(mode="json")
        for key in ("categories", "mechanics", "designers", "publishers", "labels"):
            val = row.get(key)
            if isinstance(val, str):
                try:
                    parsed = json.loads(val)
                    if isinstance(parsed, list):
                        row[key] = ";".join(parsed)
                except (json.JSONDecodeError, TypeError):
                    pass
        writer.writerow(row)
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-collection-{ts}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )

@router.get("/export/images")
def export_images(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Export all locally-stored game images as a ZIP download."""
    games = db.query(models.Game).filter(models.Game.image_url.isnot(None)).all()
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-images-{ts}.zip"
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
        for game in games:
            url = game.image_url
            if not url or url.startswith("http"):
                continue
            if url.startswith("/api/"):
                # Cached image — look in IMAGES_DIR by game ID
                if game.image_cached and game.image_ext:
                    path = os.path.join(IMAGES_DIR, f"{game.id}{game.image_ext}")
                    if os.path.isfile(path):
                        arcname = f"game-{game.id}-{os.path.basename(path)}"
                        zf.write(path, arcname)
            else:
                # Legacy path-based image — validate stays within FRONTEND_PATH
                base = os.path.realpath(FRONTEND_PATH or ".")
                path = os.path.realpath(os.path.join(base, url.lstrip("/")))
                if path.startswith(base + os.sep) and os.path.isfile(path):
                    arcname = f"game-{game.id}-{os.path.basename(path)}"
                    zf.write(path, arcname)
    tmp.close()
    background_tasks.add_task(os.remove, tmp.name)
    return FileResponse(
        tmp.name,
        media_type="application/zip",
        filename=filename,
    )

RESTORE_MAX_BYTES = 500 * 1024 * 1024  # 500 MB
_MEDIA_DIRS = ["images", "gallery", "instructions", "avatars"]

async def _stream_backup_to_tempfile(file: UploadFile, suffix: str = ".zip", dir: str = None) -> tempfile.NamedTemporaryFile:
    """Stream an uploaded file to a temp file, enforcing RESTORE_MAX_BYTES."""
    kwargs = {"suffix": suffix, "delete": False}
    if dir:
        kwargs["dir"] = dir
    tmp = tempfile.NamedTemporaryFile(**kwargs)
    total = 0
    try:
        while True:
            chunk = await file.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > RESTORE_MAX_BYTES:
                tmp.close()
                os.unlink(tmp.name)
                raise HTTPException(status_code=413, detail="Backup file too large (max 500 MB)")
            tmp.write(chunk)
    except HTTPException:
        tmp.close()
        os.unlink(tmp.name)
        raise
    except Exception:
        tmp.close()
        os.unlink(tmp.name)
        raise
    tmp.close()
    return tmp

def _extract_and_validate_db(zf: zipfile.ZipFile, tmp_zip_name: str, db_suffix: str) -> tuple[sqlite3.Connection, str]:
    """Extract cardboard.db from a ZIP and return an open, integrity-checked connection."""
    if "cardboard.db" not in zf.namelist():
        raise HTTPException(status_code=422, detail="Invalid backup: cardboard.db not found in ZIP")
    db_tmp = tmp_zip_name + db_suffix
    MAX_DB_SIZE = 500 * 1024 * 1024  # 500 MB
    db_size = 0
    with zf.open("cardboard.db") as src, open(db_tmp, "wb") as dst:
        while chunk := src.read(65536):
            db_size += len(chunk)
            if db_size > MAX_DB_SIZE:
                dst.close()
                os.unlink(db_tmp)
                raise HTTPException(status_code=413, detail="Backup database exceeds 500 MB limit")
            dst.write(chunk)
    conn = sqlite3.connect(db_tmp)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise HTTPException(status_code=422, detail="Backup database failed integrity check")
    except HTTPException:
        conn.close()
        safe_delete_file(db_tmp)
        raise
    except sqlite3.DatabaseError:
        conn.close()
        safe_delete_file(db_tmp)
        raise HTTPException(status_code=422, detail="Backup database is corrupt or not a valid SQLite file")
    return conn, db_tmp

@router.post("/restore", status_code=200)
async def restore_backup(file: UploadFile = File(...)):
    """
    Restore from a ZIP backup created by GET /api/games/backup.
    The ZIP must contain a `cardboard.db` file.  Media files
    (images/, gallery/, instructions/) are also restored if present.
    The server restarts the database connection after the restore.
    """
    data_dir = os.getenv("DATA_DIR", "/app/data")
    db_url = os.getenv("DATABASE_URL", "sqlite:///./data/cardboard.db")
    db_path = db_url.replace("sqlite+aiosqlite:///", "").replace("sqlite:///", "")
    if not os.path.isabs(db_path):
        db_path = os.path.join("/app", db_path)

    validate_file_extension(file.filename or "", {".zip"}, "Only .zip backup files are allowed")

    db_tmp = None
    tmp_zip = None
    try:
        tmp_zip = await _stream_backup_to_tempfile(file, dir=data_dir)
        with zipfile.ZipFile(tmp_zip.name, "r") as zf:
            conn, db_tmp = _extract_and_validate_db(zf, tmp_zip.name, ".restore.db")
            conn.close()

            # Atomically replace the database — temp file is in same dir as db_path
            os.replace(db_tmp, db_path)
            db_tmp = None  # os.replace consumed it

            # Invalidate the connection pool so all future requests open fresh
            # connections against the restored file (old pooled connections still
            # point to the previous inode via SQLite WAL).
            engine.dispose()

            # Restore media directories (optional — skip missing)
            safe_data_dir = os.path.realpath(data_dir) + os.sep
            MAX_DECOMPRESSED_PER_FILE = 200 * 1024 * 1024  # 200 MB per file
            for arc_path in zf.namelist():
                if not any(arc_path.startswith(d + "/") for d in _MEDIA_DIRS):
                    continue
                dest = os.path.realpath(os.path.join(data_dir, arc_path))
                if os.path.commonpath([safe_data_dir, dest]) != os.path.realpath(data_dir):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                file_size = 0
                with zf.open(arc_path) as src, open(dest, "wb") as dst:
                    while chunk := src.read(65536):
                        file_size += len(chunk)
                        if file_size > MAX_DECOMPRESSED_PER_FILE:
                            dst.close()
                            os.unlink(dest)
                            raise HTTPException(status_code=413, detail=f"Backup file {arc_path} exceeds 200 MB limit")
                        dst.write(chunk)

        logger.info("Restore completed from uploaded backup")
        return {"detail": "Restore successful. Reload the page to see your restored data."}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Restore failed: %s", exc)
        raise HTTPException(status_code=500, detail="Restore failed. The backup may be invalid.")
    finally:
        if tmp_zip:
            safe_delete_file(tmp_zip.name)
        if db_tmp:
            safe_delete_file(db_tmp)

@router.post("/restore/preview", status_code=200)
async def preview_restore(file: UploadFile = File(...)):
    """
    Preview a ZIP backup before restoring. Returns counts and game list
    so the user can verify they are uploading the right backup.
    Does NOT modify any data.
    """
    validate_file_extension(file.filename or "", {".zip"}, "Only .zip backup files are allowed")

    tmp_zip = None
    db_tmp = None
    try:
        tmp_zip = await _stream_backup_to_tempfile(file)
        with zipfile.ZipFile(tmp_zip.name, "r") as zf:
            names = zf.namelist()
            conn, db_tmp = _extract_and_validate_db(zf, tmp_zip.name, ".preview.db")
            try:
                game_count = conn.execute("SELECT COUNT(*) FROM games").fetchone()[0]
                session_count = conn.execute("SELECT COUNT(*) FROM play_sessions").fetchone()[0]
                player_count = conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]

                status_counts = {}
                try:
                    for status, cnt in conn.execute(
                        "SELECT status, COUNT(*) FROM games GROUP BY status"
                    ).fetchall():
                        status_counts[status] = cnt
                except Exception:
                    pass

                try:
                    games_preview = [
                        row[0] for row in
                        conn.execute("SELECT name FROM games ORDER BY name LIMIT 15").fetchall()
                    ]
                except Exception:
                    games_preview = []

                media_count = sum(
                    1 for n in names
                    if any(n.startswith(d + "/") for d in _MEDIA_DIRS) and not n.endswith("/")
                )
            finally:
                conn.close()

        return {
            "game_count": game_count,
            "session_count": session_count,
            "player_count": player_count,
            "owned_count": status_counts.get("owned", 0),
            "wishlist_count": status_counts.get("wishlist", 0),
            "sold_count": status_counts.get("sold", 0),
            "games_preview": games_preview,
            "media_file_count": media_count,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Preview failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to preview backup")
    finally:
        if tmp_zip:
            safe_delete_file(tmp_zip.name)
        if db_tmp:
            safe_delete_file(db_tmp)
