"""
Elo rating engine for multiplayer board-game sessions.

Uses standard Elo with a variable K-factor:
  K = 40 if games_played < 10
  K = 20 if 10 <= games_played < 30
  K = 10 if games_played >= 30

For multiplayer sessions, every pair of players is treated as a match.
The higher-scoring player wins the pair; ties award 0.5 to both.
Sessions without scores are ignored.
"""

from typing import Dict, List, Tuple


def _k_factor(games_played: int) -> float:
    if games_played < 10:
        return 40.0
    if games_played < 30:
        return 20.0
    return 10.0


def _expected_score(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def compute_elo_updates(
    current_ratings: Dict[int, float],
    games_played: Dict[int, int],
    scores: Dict[int, int],
) -> Dict[int, float]:
    """
    Given current ratings and a single session's scores, return rating deltas.

    Args:
        current_ratings: player_id -> current Elo rating
        games_played: player_id -> number of rated games played so far
        scores: player_id -> score for this session (all must be present and non-null)

    Returns:
        player_id -> rating delta (add to current rating for new rating)
    """
    player_ids = list(scores.keys())
    if len(player_ids) < 2:
        return {pid: 0.0 for pid in player_ids}

    deltas = {pid: 0.0 for pid in player_ids}

    for i, pid_a in enumerate(player_ids):
        for pid_b in player_ids[i + 1 :]:
            score_a = scores[pid_a]
            score_b = scores[pid_b]

            if score_a > score_b:
                actual_a, actual_b = 1.0, 0.0
            elif score_a < score_b:
                actual_a, actual_b = 0.0, 1.0
            else:
                actual_a, actual_b = 0.5, 0.5

            r_a = current_ratings.get(pid_a, 1500.0)
            r_b = current_ratings.get(pid_b, 1500.0)

            e_a = _expected_score(r_a, r_b)
            e_b = _expected_score(r_b, r_a)

            k_a = _k_factor(games_played.get(pid_a, 0))
            k_b = _k_factor(games_played.get(pid_b, 0))

            deltas[pid_a] += k_a * (actual_a - e_a)
            deltas[pid_b] += k_b * (actual_b - e_b)

    return deltas


def batch_recalculate_elo(
    sessions: List[Tuple[int, Dict[int, int]]],
    initial_rating: float = 1500.0,
) -> Tuple[Dict[int, float], Dict[int, int]]:
    """
    Recalculate Elo ratings from an ordered list of scored sessions.

    Args:
        sessions: List of (session_id, {player_id: score}) tuples in chronological order.
        initial_rating: Starting rating for all players.

    Returns:
        (final_ratings, games_played) dicts.
    """
    ratings: Dict[int, float] = {}
    games_played: Dict[int, int] = {}

    for _session_id, scores in sessions:
        if not scores or len(scores) < 2:
            continue

        # Ensure all players have an entry
        for pid in scores:
            if pid not in ratings:
                ratings[pid] = initial_rating
            if pid not in games_played:
                games_played[pid] = 0

        deltas = compute_elo_updates(ratings, games_played, scores)
        for pid, delta in deltas.items():
            ratings[pid] += delta
            games_played[pid] += 1

    return ratings, games_played
