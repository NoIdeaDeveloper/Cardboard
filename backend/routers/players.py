import logging
import os
import uuid
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils import get_player_or_404, safe_delete_file, safe_write_file, validate_file_extension

logger = logging.getLogger("cardboard.players")
router = APIRouter(prefix="/api/players", tags=["players"])

AVATAR_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
_ALLOWED_AVATAR_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
_VALID_PRESETS = {"meeple", "dice", "robot", "crown", "cat", "fox", "bear", "knight"}


def _avatars_dir() -> str:
    return os.path.join(os.getenv("DATA_DIR", "/app/data"), "avatars")


def _avatar_path(player: models.Player) -> str:
    return os.path.join(_avatars_dir(), f"{player.id}{player.avatar_ext}")


def _avatar_url(player: models.Player) -> str | None:
    if player.avatar_ext:
        return f"/api/players/{player.id}/avatar"
    if player.avatar_preset:
        return f"/avatars/{player.avatar_preset}.svg"
    return None


def _build_response(player: models.Player, session_count: int = 0, win_count: int = 0) -> schemas.PlayerResponse:
    r = schemas.PlayerResponse.model_validate(player)
    r.session_count = session_count
    r.win_count = win_count
    r.avatar_url = _avatar_url(player)
    r.avatar_preset = player.avatar_preset
    r.elo_rating = player.elo_rating
    r.games_played = player.games_played
    return r


@router.get("/", response_model=List[schemas.PlayerResponse])
def get_players(db: Session = Depends(get_db)):
    session_counts = (
        db.query(models.SessionPlayer.player_id, func.count().label("cnt"))
        .group_by(models.SessionPlayer.player_id)
        .subquery()
    )
    win_counts = (
        db.query(models.SessionPlayer.player_id.label("player_id"), func.count().label("wins"))
        .join(models.PlaySession, models.PlaySession.id == models.SessionPlayer.session_id)
        .join(models.Player, models.Player.id == models.SessionPlayer.player_id)
        .filter(
            models.PlaySession.winner == models.Player.name,
            models.PlaySession.winner.isnot(None),
        )
        .group_by(models.SessionPlayer.player_id)
        .subquery()
    )
    rows = (
        db.query(
            models.Player,
            func.coalesce(session_counts.c.cnt, 0).label("session_count"),
            func.coalesce(win_counts.c.wins, 0).label("win_count"),
        )
        .outerjoin(session_counts, models.Player.id == session_counts.c.player_id)
        .outerjoin(win_counts, models.Player.id == win_counts.c.player_id)
        .order_by(models.Player.name)
        .all()
    )
    return [_build_response(player, cnt, wins) for player, cnt, wins in rows]


@router.post("/", response_model=schemas.PlayerResponse, status_code=201)
def create_player(player: schemas.PlayerCreate, db: Session = Depends(get_db)):
    existing = db.query(models.Player).filter(models.Player.name == player.name).first()
    if existing:
        return JSONResponse(
            content=_build_response(existing).model_dump(mode="json"),
            status_code=200,
        )
    db_player = models.Player(name=player.name)
    db.add(db_player)
    db.commit()
    db.refresh(db_player)
    logger.info("Player created: %r", db_player.name)
    return _build_response(db_player)


@router.patch("/{player_id}", response_model=schemas.PlayerResponse)
def rename_player(player_id: int, data: schemas.PlayerUpdate, db: Session = Depends(get_db)):
    player = get_player_or_404(player_id, db)
    new_name = data.name
    if not new_name:
        raise HTTPException(status_code=422, detail="Name cannot be empty")
    conflict = (
        db.query(models.Player)
        .filter(models.Player.name == new_name, models.Player.id != player_id)
        .first()
    )
    if conflict:
        raise HTTPException(status_code=409, detail="A player with that name already exists")
    old_name = player.name
    player.name = new_name
    db.query(models.PlaySession).filter(models.PlaySession.winner == old_name).update({"winner": new_name})
    db.commit()
    db.refresh(player)
    logger.info("Player renamed: id=%d new_name=%r", player_id, new_name)
    cnt = (
        db.query(func.count())
        .select_from(models.SessionPlayer)
        .filter(models.SessionPlayer.player_id == player_id)
        .scalar()
    )
    wins = (
        db.query(func.count())
        .select_from(models.PlaySession)
        .filter(models.PlaySession.winner == player.name, models.PlaySession.winner.isnot(None))
        .scalar()
    )
    return _build_response(player, cnt or 0, wins or 0)


# ── Avatar endpoints ──────────────────────────────────────────────────────────

@router.get("/{player_id}/avatar")
def get_player_avatar(player_id: int, db: Session = Depends(get_db)):
    player = get_player_or_404(player_id, db)
    if not player.avatar_ext:
        raise HTTPException(status_code=404, detail="No custom avatar uploaded")
    path = _avatar_path(player)
    safe_dir = os.path.realpath(_avatars_dir())
    real_path = os.path.realpath(path)
    if not real_path.startswith(safe_dir + os.sep) or not os.path.isfile(real_path):
        raise HTTPException(status_code=404, detail="Avatar file not found")
    return FileResponse(real_path)


@router.post("/{player_id}/avatar", response_model=schemas.PlayerResponse)
async def upload_player_avatar(
    player_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    player = get_player_or_404(player_id, db)
    ext = validate_file_extension(
        file.filename or "",
        _ALLOWED_AVATAR_EXTS,
        "Only JPG, PNG, WebP, or GIF images are allowed",
    )
    content = await file.read(AVATAR_MAX_BYTES + 1)
    if len(content) > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Avatar too large (max 5 MB)")

    os.makedirs(_avatars_dir(), exist_ok=True)

    # Remove old avatar file if it exists and is a different extension
    if player.avatar_ext and player.avatar_ext != ext:
        safe_delete_file(_avatar_path(player))

    player.avatar_ext = ext
    player.avatar_preset = None  # custom upload supersedes any preset

    dest = _avatar_path(player)
    safe_write_file(dest, content, f"Avatar write failed for player {player_id}", "Failed to save avatar")
    db.commit()

    logger.info("Avatar uploaded for player id=%d ext=%s", player_id, ext)
    cnt = (
        db.query(func.count())
        .select_from(models.SessionPlayer)
        .filter(models.SessionPlayer.player_id == player_id)
        .scalar()
    )
    wins = (
        db.query(func.count())
        .select_from(models.PlaySession)
        .filter(models.PlaySession.winner == player.name, models.PlaySession.winner.isnot(None))
        .scalar()
    )
    return _build_response(player, cnt or 0, wins or 0)


@router.post("/{player_id}/avatar/preset", response_model=schemas.PlayerResponse)
def set_player_avatar_preset(
    player_id: int,
    data: schemas.AvatarPresetSet,
    db: Session = Depends(get_db),
):
    player = get_player_or_404(player_id, db)
    if data.preset not in _VALID_PRESETS:
        raise HTTPException(status_code=422, detail=f"Unknown preset '{data.preset}'")
    if player.avatar_ext:
        safe_delete_file(_avatar_path(player))
        player.avatar_ext = None
    player.avatar_preset = data.preset
    db.commit()
    db.refresh(player)
    logger.info("Avatar preset set for player id=%d preset=%s", player_id, data.preset)
    cnt = (
        db.query(func.count())
        .select_from(models.SessionPlayer)
        .filter(models.SessionPlayer.player_id == player_id)
        .scalar()
    )
    wins = (
        db.query(func.count())
        .select_from(models.PlaySession)
        .filter(models.PlaySession.winner == player.name, models.PlaySession.winner.isnot(None))
        .scalar()
    )
    return _build_response(player, cnt or 0, wins or 0)


@router.delete("/{player_id}/avatar", status_code=204)
def delete_player_avatar(player_id: int, db: Session = Depends(get_db)):
    player = get_player_or_404(player_id, db)
    if not player.avatar_ext and not player.avatar_preset:
        raise HTTPException(status_code=404, detail="No avatar to delete")
    if player.avatar_ext:
        safe_delete_file(_avatar_path(player))
        player.avatar_ext = None
    player.avatar_preset = None
    db.commit()
    logger.info("Avatar cleared for player id=%d", player_id)


# ── Rankings ─────────────────────────────────────────────────────────────────

@router.get("/rankings", response_model=List[schemas.PlayerRankingResponse])
def get_player_rankings(db: Session = Depends(get_db)):
    """Return global player leaderboard sorted by Elo rating."""
    players = (
        db.query(models.Player)
        .order_by(models.Player.elo_rating.desc())
        .all()
    )

    # Pre-compute win counts and avg scores
    player_ids = [p.id for p in players]
    win_rows = (
        db.query(models.Player.id, func.count(models.PlaySession.id).label("wins"))
        .join(models.PlaySession, models.PlaySession.winner == models.Player.name)
        .filter(models.Player.id.in_(player_ids), models.PlaySession.winner.isnot(None))
        .group_by(models.Player.id)
        .all()
    ) if player_ids else []
    win_by_id = {r.id: r.wins for r in win_rows}

    avg_score_rows = (
        db.query(models.SessionPlayer.player_id, func.avg(models.SessionPlayer.score).label("avg"))
        .filter(models.SessionPlayer.player_id.in_(player_ids), models.SessionPlayer.score.isnot(None))
        .group_by(models.SessionPlayer.player_id)
        .all()
    ) if player_ids else []
    avg_score_by_id = {r.player_id: float(r.avg) for r in avg_score_rows}

    results = []
    for rank, player in enumerate(players, start=1):
        wins = win_by_id.get(player.id, 0)
        gp = player.games_played
        win_rate = round(wins / gp * 100) if gp > 0 else 0
        results.append(schemas.PlayerRankingResponse(
            player_id=player.id,
            player_name=player.name,
            elo_rating=round(player.elo_rating, 1),
            games_played=gp,
            wins=wins,
            win_rate=win_rate,
            avg_score=round(avg_score_by_id.get(player.id, 0), 1) if player.id in avg_score_by_id else None,
            avatar_url=_avatar_url(player),
            rank=rank,
        ))
    return results


@router.get("/{player_id}/rankings", response_model=List[schemas.PlayerRankingResponse])
def get_player_game_rankings(player_id: int, db: Session = Depends(get_db)):
    """Return per-game rankings for a specific player."""
    player = get_player_or_404(player_id, db)

    # Find all games this player has scored sessions for
    game_rows = (
        db.query(models.Game.id, models.Game.name)
        .join(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.player_id == player_id)
        .filter(models.SessionPlayer.score.isnot(None))
        .distinct()
        .all()
    )

    rankings = []
    for game_id, game_name in game_rows:
        # Get all players for this game with scored sessions, ordered by average score
        player_rows = (
            db.query(
                models.Player.id,
                models.Player.name,
                models.Player.elo_rating,
                models.Player.games_played,
                func.count(models.SessionPlayer.session_id).label("session_count"),
                func.avg(models.SessionPlayer.score).label("avg_score"),
            )
            .join(models.SessionPlayer, models.SessionPlayer.player_id == models.Player.id)
            .join(models.PlaySession, models.PlaySession.id == models.SessionPlayer.session_id)
            .filter(models.PlaySession.game_id == game_id)
            .filter(models.SessionPlayer.score.isnot(None))
            .group_by(models.Player.id, models.Player.name, models.Player.elo_rating, models.Player.games_played)
            .order_by(func.avg(models.SessionPlayer.score).desc())
            .all()
        )

        win_rows = (
            db.query(models.Player.id, func.count(models.PlaySession.id).label("wins"))
            .join(models.PlaySession, models.PlaySession.winner == models.Player.name)
            .filter(models.PlaySession.game_id == game_id)
            .filter(models.PlaySession.winner.isnot(None))
            .group_by(models.Player.id)
            .all()
        )
        win_by_id = {r.id: r.wins for r in win_rows}

        for rank, row in enumerate(player_rows, start=1):
            if row.id == player_id:
                wins = win_by_id.get(row.id, 0)
                win_rate = round(wins / row.session_count * 100) if row.session_count > 0 else 0
                rankings.append(schemas.PlayerRankingResponse(
                    player_id=row.id,
                    player_name=row.name,
                    elo_rating=round(row.elo_rating, 1),
                    games_played=row.games_played,
                    wins=wins,
                    win_rate=win_rate,
                    avg_score=round(float(row.avg_score), 1) if row.avg_score else None,
                    avatar_url=_avatar_url(row),
                    rank=rank,
                ))
                break

    return rankings


# ── Stats ────────────────────────────────────────────────────────────────────

@router.get("/{player_id}/stats", response_model=schemas.PlayerStatsResponse)
def get_player_stats(player_id: int, db: Session = Depends(get_db)):
    player = get_player_or_404(player_id, db)

    session_count = (
        db.query(func.count())
        .select_from(models.SessionPlayer)
        .filter(models.SessionPlayer.player_id == player_id)
        .scalar() or 0
    )
    win_count = (
        db.query(func.count())
        .select_from(models.PlaySession)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(
            models.SessionPlayer.player_id == player_id,
            models.PlaySession.winner == player.name,
            models.PlaySession.winner.isnot(None),
        )
        .scalar() or 0
    )
    last_played_row = (
        db.query(func.max(models.PlaySession.played_at))
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.player_id == player_id)
        .scalar()
    )

    # Top 3 games by play count for this player
    top_games_rows = (
        db.query(models.Game.id, models.Game.name, func.count().label("play_count"))
        .join(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.player_id == player_id)
        .group_by(models.Game.id, models.Game.name)
        .order_by(func.count().desc())
        .limit(3)
        .all()
    )

    # Sessions by month
    sessions_by_month_rows = (
        db.query(
            func.strftime("%Y-%m", models.PlaySession.played_at).label("month"),
            func.count().label("count"),
        )
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.player_id == player_id)
        .group_by("month")
        .order_by("month")
        .all()
    )

    # All co-players (most sessions in common)
    co_player_rows = (
        db.query(models.Player.id, models.Player.name, models.Player.avatar_ext, models.Player.avatar_preset, func.count().label("co_count"))
        .join(models.SessionPlayer, models.SessionPlayer.player_id == models.Player.id)
        .filter(
            models.SessionPlayer.session_id.in_(
                db.query(models.SessionPlayer.session_id)
                .filter(models.SessionPlayer.player_id == player_id)
            ),
            models.Player.id != player_id,
        )
        .group_by(models.Player.id, models.Player.name, models.Player.avatar_ext, models.Player.avatar_preset)
        .order_by(func.count().desc())
        .all()
    )

    # Head-to-head W/L for each co-player, in one aggregated query over sessions
    # that both the target player and each co-player participated in.
    target_sessions = (
        db.query(models.SessionPlayer.session_id)
        .filter(models.SessionPlayer.player_id == player_id)
        .subquery()
    )
    rivalry_rows = (
        db.query(
            models.Player.id.label("co_id"),
            func.sum(case((models.PlaySession.winner == player.name, 1), else_=0)).label("wins"),
            func.sum(case((models.PlaySession.winner == models.Player.name, 1), else_=0)).label("losses"),
        )
        .select_from(models.Player)
        .join(models.SessionPlayer, models.SessionPlayer.player_id == models.Player.id)
        .join(models.PlaySession, models.PlaySession.id == models.SessionPlayer.session_id)
        .filter(
            models.SessionPlayer.session_id.in_(target_sessions.select()),
            models.Player.id != player_id,
            models.PlaySession.winner.isnot(None),
        )
        .group_by(models.Player.id)
        .all()
    )
    rivalry_data = {r.co_id: (int(r.wins or 0), int(r.losses or 0)) for r in rivalry_rows}

    # Chronological decided-session history for streak and recent form.
    # Streak can be arbitrarily long so no LIMIT applied; monthly rates use SQL.
    history_rows = (
        db.query(models.PlaySession.winner)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(
            models.SessionPlayer.player_id == player_id,
            models.PlaySession.winner.isnot(None),
        )
        .order_by(models.PlaySession.played_at.asc(), models.PlaySession.id.asc())
        .all()
    )
    wlseq = ["W" if r.winner == player.name else "L" for r in history_rows]

    recent_form = list(reversed(wlseq[-10:]))

    streak_kind, streak_len = "", 0
    for result in reversed(wlseq):
        if not streak_kind:
            streak_kind = result
            streak_len = 1
        elif result == streak_kind:
            streak_len += 1
        else:
            break

    # Monthly win-rate via SQL aggregation — avoids loading all rows into Python.
    month_rate_rows = (
        db.query(
            func.strftime("%Y-%m", models.PlaySession.played_at).label("month"),
            func.count().label("total"),
            func.sum(case((models.PlaySession.winner == player.name, 1), else_=0)).label("wins"),
        )
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(
            models.SessionPlayer.player_id == player_id,
            models.PlaySession.winner.isnot(None),
        )
        .group_by("month")
        .order_by("month")
        .all()
    )
    win_rate_by_month = [
        schemas.PlayerWinRateByMonth(
            month=r.month,
            win_rate=round(r.wins / r.total * 100),
            sessions=r.total,
        )
        for r in month_rate_rows
    ]

    # Zero-fill both month series for the trailing 12 months
    today = date.today()
    trailing_months: list[str] = []
    for i in range(11, -1, -1):
        month = today.month - i
        year = today.year
        while month <= 0:
            month += 12
            year -= 1
        trailing_months.append(f"{year}-{month:02d}")

    sbm_map = {r.month: r.count for r in sessions_by_month_rows}
    sessions_by_month_filled = [
        schemas.PlayerSessionsByMonth(month=m, count=sbm_map.get(m, 0))
        for m in trailing_months
    ]

    wrbm_map = {r.month: r for r in win_rate_by_month}
    win_rate_by_month_filled = [
        wrbm_map[m] if m in wrbm_map
        else schemas.PlayerWinRateByMonth(month=m, win_rate=0, sessions=0)
        for m in trailing_months
    ]

    return schemas.PlayerStatsResponse(
        session_count=session_count,
        win_count=win_count,
        last_played=last_played_row,
        top_games=[
            schemas.PlayerTopGame(game_id=g.id, game_name=g.name, play_count=g.play_count)
            for g in top_games_rows
        ],
        most_played_with=[
            schemas.PlayerCoPlayer(
                player_id=c.id,
                player_name=c.name,
                count=c.co_count,
                wins_against=rivalry_data.get(c.id, (0, 0))[0],
                losses_to=rivalry_data.get(c.id, (0, 0))[1],
                avatar_url=(f"/api/players/{c.id}/avatar" if c.avatar_ext else f"/avatars/{c.avatar_preset}.svg" if c.avatar_preset else None),
            )
            for c in co_player_rows
        ],
        sessions_by_month=sessions_by_month_filled,
        recent_form=recent_form,
        current_streak=schemas.PlayerStreak(kind=streak_kind, length=streak_len),
        win_rate_by_month=win_rate_by_month_filled,
    )


@router.get("/{player_id}/sessions", response_model=List[schemas.PlayerSessionResponse])
def get_player_sessions(player_id: int, db: Session = Depends(get_db)):
    get_player_or_404(player_id, db)

    sessions = (
        db.query(models.PlaySession)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.player_id == player_id)
        .order_by(models.PlaySession.played_at.desc())
        .all()
    )
    if not sessions:
        return []

    session_ids = [s.id for s in sessions]
    player_rows = (
        db.query(models.SessionPlayer.session_id, models.Player.name, models.SessionPlayer.score)
        .join(models.Player, models.Player.id == models.SessionPlayer.player_id)
        .filter(models.SessionPlayer.session_id.in_(session_ids))
        .all()
    )
    players_by_session: dict = {}
    scores_by_session: dict = {}
    for sid, name, score in player_rows:
        players_by_session.setdefault(sid, []).append(name)
        if score is not None:
            scores_by_session.setdefault(sid, {})[name] = score

    game_ids = list({s.game_id for s in sessions})
    game_rows = db.query(models.Game.id, models.Game.name, models.Game.image_url, models.Game.thumbnail_url).filter(
        models.Game.id.in_(game_ids)
    ).all()
    game_info = {g.id: (g.name, g.image_url or g.thumbnail_url) for g in game_rows}

    results = []
    for s in sessions:
        resp = schemas.PlayerSessionResponse.model_validate(s)
        resp.players = players_by_session.get(s.id, [])
        resp.player_scores = scores_by_session.get(s.id, {})
        title, thumb = game_info.get(s.game_id, ("Unknown Game", None))
        resp.game_name = title
        resp.game_thumbnail = thumb
        results.append(resp)
    return results


@router.delete("/{player_id}", status_code=204)
def delete_player(player_id: int, db: Session = Depends(get_db)):
    player = get_player_or_404(player_id, db)
    # Clean up avatar file before deleting the player record
    if player.avatar_ext:
        safe_delete_file(_avatar_path(player))
    db.delete(player)
    db.commit()
    logger.info("Player deleted: id=%d", player_id)


# ── Admin / Maintenance ─────────────────────────────────────────────────────

@router.post("/admin/recalculate-elo")
def recalculate_all_elo(db: Session = Depends(get_db)):
    """Recalculate Elo ratings for all players from scored session history."""
    import elo_db
    all_ids = {r.id for r in db.query(models.Player.id).all()}
    if not all_ids:
        return {"message": "No players to recalculate", "players_updated": 0}
    elo_db.recalculate_elo_for_players(all_ids, db)
    db.commit()
    return {"message": "Elo recalculated", "players_updated": len(all_ids)}
