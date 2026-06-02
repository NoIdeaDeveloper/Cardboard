"""
Database helpers for Elo rating updates.
"""

from typing import Dict, List, Set
from sqlalchemy.orm import Session
import models
from elo import compute_elo_updates, batch_recalculate_elo


def _fetch_player_map(names: List[str], db: Session) -> Dict[str, int]:
    """Return name -> player_id for existing players."""
    rows = db.query(models.Player.name, models.Player.id).filter(models.Player.name.in_(names)).all()
    return {name: pid for name, pid in rows}


def apply_elo_for_new_session(
    player_names: List[str],
    scores: Dict[str, int],
    db: Session,
) -> None:
    """
    Apply Elo updates for a newly created session.
    Call AFTER _link_players so player records exist.
    """
    if not scores or len(scores) < 2:
        return

    name_to_id = _fetch_player_map(player_names, db)
    pid_to_score: Dict[int, int] = {}
    for name, score in scores.items():
        pid = name_to_id.get(name)
        if pid is not None and score is not None:
            pid_to_score[pid] = score

    if len(pid_to_score) < 2:
        return

    pids = list(pid_to_score.keys())
    players = db.query(models.Player).filter(models.Player.id.in_(pids)).all()
    ratings = {p.id: p.elo_rating for p in players}
    games_played = {p.id: p.games_played for p in players}

    deltas = compute_elo_updates(ratings, games_played, pid_to_score)
    for p in players:
        delta = deltas.get(p.id, 0.0)
        p.elo_rating += delta
        p.games_played += 1

    db.flush()


def recalculate_elo_for_players(player_ids: Set[int], db: Session) -> None:
    """
    Recalculate Elo from scratch for a set of players by replaying all their scored sessions.
    Used after session update or delete.
    """
    if not player_ids:
        return

    # Fetch all scored sessions that involve any of these players, ordered chronologically
    sessions = (
        db.query(models.PlaySession)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.player_id.in_(list(player_ids)))
        .filter(models.SessionPlayer.score.isnot(None))
        .order_by(models.PlaySession.played_at.asc(), models.PlaySession.id.asc())
        .all()
    )

    session_ids = [s.id for s in sessions]
    if not session_ids:
        # No scored sessions remain — reset these players to default
        players = db.query(models.Player).filter(models.Player.id.in_(list(player_ids))).all()
        for p in players:
            p.elo_rating = 1500.0
            p.games_played = 0
        db.flush()
        return

    score_rows = (
        db.query(models.SessionPlayer.session_id, models.SessionPlayer.player_id, models.SessionPlayer.score)
        .filter(models.SessionPlayer.session_id.in_(session_ids))
        .filter(models.SessionPlayer.score.isnot(None))
        .all()
    )

    scores_by_session: Dict[int, Dict[int, int]] = {}
    for sid, pid, score in score_rows:
        scores_by_session.setdefault(sid, {})[pid] = score

    sessions_data = []
    active_player_ids: Set[int] = set()
    for s in sessions:
        sc = scores_by_session.get(s.id, {})
        if len(sc) >= 2:
            sessions_data.append((s.id, sc))
            active_player_ids.update(sc.keys())

    # Reset all players being recalculated
    all_to_reset = player_ids | active_player_ids
    players = db.query(models.Player).filter(models.Player.id.in_(list(all_to_reset))).all()
    for p in players:
        p.elo_rating = 1500.0
        p.games_played = 0
    db.flush()

    # Recalculate
    final_ratings, final_games = batch_recalculate_elo(sessions_data)

    # Apply results
    for p in players:
        if p.id in final_ratings:
            p.elo_rating = final_ratings[p.id]
            p.games_played = final_games[p.id]
        else:
            p.elo_rating = 1500.0
            p.games_played = 0

    db.flush()
