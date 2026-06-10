"""
Database helpers for Elo rating updates.
"""

from typing import Dict, List, Set
from sqlalchemy.orm import Session
from sqlalchemy import and_
import models
from elo import compute_elo_updates, batch_recalculate_elo


def _fetch_player_map(names: List[str], db: Session) -> Dict[str, int]:
    """Return name -> player_id for existing players."""
    rows = db.query(models.Player.name, models.Player.id).filter(models.Player.name.in_(names)).all()
    return {name: pid for name, pid in rows}


def apply_elo_for_new_session(
    player_names: List[str],
    scores: Dict[str, int],
    session_id: int,
    db: Session,
) -> None:
    """
    Apply Elo updates for a newly created session.
    Call AFTER _link_players so player records exist.
    Saves Elo history snapshots for each player.
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
        # Save history snapshot
        db.add(models.EloHistory(
            session_id=session_id,
            player_id=p.id,
            elo_after=p.elo_rating,
            games_played_after=p.games_played,
        ))

    db.flush()


def _get_historical_ratings(
    session_ids: List[int],
    target_player_ids: Set[int],
    db: Session,
) -> Dict[int, Dict[int, float]]:
    """
    For each session, return the historical ratings of non-target players
    by looking at their EloHistory record for the PREVIOUS session they played.

    Returns: {session_id: {player_id: rating}}
    """
    if not session_ids:
        return {}

    # Get all non-target players who appear in these sessions
    all_participants = (
        db.query(models.SessionPlayer.session_id, models.SessionPlayer.player_id)
        .filter(models.SessionPlayer.session_id.in_(session_ids))
        .filter(models.SessionPlayer.score.isnot(None))
        .all()
    )

    non_target_pids = set()
    for sid, pid in all_participants:
        if pid not in target_player_ids:
            non_target_pids.add(pid)

    if not non_target_pids:
        return {}

    # For each non-target player, get their full Elo history ordered by session
    # We need to find what their rating was at the time of each relevant session
    history_rows = (
        db.query(
            models.EloHistory.session_id,
            models.EloHistory.player_id,
            models.EloHistory.elo_after,
        )
        .filter(models.EloHistory.player_id.in_(list(non_target_pids)))
        .order_by(models.EloHistory.session_id.asc())
        .all()
    )

    # Build player -> [(session_id, elo_after)] timeline
    player_timeline: Dict[int, List[tuple]] = {}
    for sid, pid, elo in history_rows:
        player_timeline.setdefault(pid, []).append((sid, elo))

    # For each session, find the most recent Elo for each non-target player
    # BEFORE that session
    result: Dict[int, Dict[int, float]] = {}
    for sid in session_ids:
        result[sid] = {}
        for pid in non_target_pids:
            timeline = player_timeline.get(pid, [])
            # Find the last entry before this session
            rating = 1500.0  # default
            for t_sid, t_elo in timeline:
                if t_sid < sid:
                    rating = t_elo
                else:
                    break
            result[sid][pid] = rating

    return result


def recalculate_elo_for_players(player_ids: Set[int], db: Session) -> None:
    """
    Recalculate Elo from scratch for a set of players by replaying all their scored sessions.
    Uses Elo history to get accurate historical ratings for non-target players.
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
        # Clear their history
        db.query(models.EloHistory).filter(models.EloHistory.player_id.in_(list(player_ids))).delete()
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

    # Get historical ratings for non-target players
    historical_ratings = _get_historical_ratings(session_ids, player_ids, db)

    # Reset the target players
    players = db.query(models.Player).filter(models.Player.id.in_(list(player_ids))).all()
    player_map = {p.id: p for p in players}
    for p in players:
        p.elo_rating = 1500.0
        p.games_played = 0

    # Delete old history for target players
    db.query(models.EloHistory).filter(models.EloHistory.player_id.in_(list(player_ids))).delete()
    db.flush()

    # Replay sessions with historical ratings for non-target players
    ratings: Dict[int, float] = {}
    games_played: Dict[int, int] = {}

    for session_id, scores in sessions_data:
        if not scores or len(scores) < 2:
            continue

        # Initialize target players from replay state
        for pid in scores:
            if pid in player_ids and pid not in ratings:
                ratings[pid] = 1500.0
                games_played[pid] = 0

        # For non-target players, use historical ratings
        hist = historical_ratings.get(session_id, {})
        for pid in scores:
            if pid not in player_ids and pid not in ratings:
                ratings[pid] = hist.get(pid, 1500.0)
                games_played[pid] = 0  # K-factor doesn't matter much for non-target

        deltas = compute_elo_updates(ratings, games_played, scores)
        for pid, delta in deltas.items():
            ratings[pid] += delta
            games_played[pid] = 1  # increment

        # Save history for target players
        for pid in player_ids:
            if pid in scores:
                db.add(models.EloHistory(
                    session_id=session_id,
                    player_id=pid,
                    elo_after=ratings.get(pid, 1500.0),
                    games_played_after=games_played.get(pid, 0),
                ))

    # Apply final ratings to target players
    for p in players:
        if p.id in ratings:
            p.elo_rating = ratings[p.id]
            p.games_played = games_played.get(p.id, 0)
        else:
            p.elo_rating = 1500.0
            p.games_played = 0

    db.flush()


def backfill_elo_history(db: Session) -> int:
    """
    Backfill EloHistory for all existing scored sessions.
    Returns the number of history records created.
    Used as a one-time migration step.
    """
    # Check if history already exists
    existing = db.query(models.EloHistory.id).first()
    if existing:
        return 0

    # Fetch all scored sessions in chronological order
    sessions = (
        db.query(models.PlaySession)
        .join(models.SessionPlayer, models.SessionPlayer.session_id == models.PlaySession.id)
        .filter(models.SessionPlayer.score.isnot(None))
        .order_by(models.PlaySession.played_at.asc(), models.PlaySession.id.asc())
        .distinct()
        .all()
    )

    if not sessions:
        return 0

    session_ids = [s.id for s in sessions]

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
    for s in sessions:
        sc = scores_by_session.get(s.id, {})
        if len(sc) >= 2:
            sessions_data.append((s.id, sc))

    # Replay from scratch
    final_ratings, final_games = batch_recalculate_elo(sessions_data)

    # Now replay again to capture per-session snapshots
    ratings: Dict[int, float] = {}
    gp: Dict[int, int] = {}
    count = 0

    for session_id, scores in sessions_data:
        for pid in scores:
            if pid not in ratings:
                ratings[pid] = 1500.0
                gp[pid] = 0

        deltas = compute_elo_updates(ratings, gp, scores)
        for pid, delta in deltas.items():
            ratings[pid] += delta
            gp[pid] += 1

        for pid in scores:
            db.add(models.EloHistory(
                session_id=session_id,
                player_id=pid,
                elo_after=ratings[pid],
                games_played_after=gp[pid],
            ))
            count += 1

    # Update player records with final values
    all_pids = list(ratings.keys())
    players = db.query(models.Player).filter(models.Player.id.in_(all_pids)).all()
    for p in players:
        p.elo_rating = ratings.get(p.id, 1500.0)
        p.games_played = gp.get(p.id, 0)

    db.flush()
    return count
