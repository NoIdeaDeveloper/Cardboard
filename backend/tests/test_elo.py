import pytest
from elo import compute_elo_updates, batch_recalculate_elo, _k_factor, _expected_score


class TestKFactor:
    def test_new_player(self):
        assert _k_factor(0) == 40.0
        assert _k_factor(9) == 40.0

    def test_intermediate(self):
        assert _k_factor(10) == 20.0
        assert _k_factor(29) == 20.0

    def test_veteran(self):
        assert _k_factor(30) == 10.0
        assert _k_factor(100) == 10.0


class TestExpectedScore:
    def test_equal_ratings(self):
        assert _expected_score(1500, 1500) == pytest.approx(0.5)

    def test_favorite(self):
        assert _expected_score(1600, 1500) > 0.5

    def test_underdog(self):
        assert _expected_score(1400, 1500) < 0.5

    def test_symmetry(self):
        assert _expected_score(1600, 1500) + _expected_score(1500, 1600) == pytest.approx(1.0)


class TestComputeEloUpdates:
    def test_two_player_win(self):
        ratings = {1: 1500.0, 2: 1500.0}
        games = {1: 0, 2: 0}
        deltas = compute_elo_updates(ratings, games, {1: 10, 2: 5})
        assert deltas[1] > 0
        assert deltas[2] < 0
        assert deltas[1] + deltas[2] == pytest.approx(0.0, abs=0.01)

    def test_two_player_tie(self):
        ratings = {1: 1500.0, 2: 1500.0}
        games = {1: 0, 2: 0}
        deltas = compute_elo_updates(ratings, games, {1: 10, 2: 10})
        assert deltas[1] == pytest.approx(0.0, abs=0.01)
        assert deltas[2] == pytest.approx(0.0, abs=0.01)

    def test_three_player(self):
        ratings = {1: 1500.0, 2: 1500.0, 3: 1500.0}
        games = {1: 0, 2: 0, 3: 0}
        deltas = compute_elo_updates(ratings, games, {1: 30, 2: 20, 3: 10})
        # Winner should gain, loser should lose
        assert deltas[1] > 0
        assert deltas[3] < 0
        # Net change should be near zero
        total = sum(deltas.values())
        assert total == pytest.approx(0.0, abs=0.01)

    def test_three_player_tie(self):
        ratings = {1: 1500.0, 2: 1500.0, 3: 1500.0}
        games = {1: 0, 2: 0, 3: 0}
        deltas = compute_elo_updates(ratings, games, {1: 10, 2: 10, 3: 10})
        assert deltas[1] == pytest.approx(0.0, abs=0.01)
        assert deltas[2] == pytest.approx(0.0, abs=0.01)
        assert deltas[3] == pytest.approx(0.0, abs=0.01)

    def test_less_than_two_players(self):
        deltas = compute_elo_updates({1: 1500.0}, {1: 0}, {1: 10})
        assert deltas[1] == 0.0

    def test_k_factor_progression(self):
        ratings = {1: 1500.0, 2: 1500.0}
        games = {1: 9, 2: 9}
        deltas_before = compute_elo_updates(ratings, games, {1: 10, 2: 5})
        games = {1: 10, 2: 10}
        deltas_after = compute_elo_updates(ratings, games, {1: 10, 2: 5})
        # After K drops from 40 to 20, deltas should be roughly half
        assert abs(deltas_after[1]) < abs(deltas_before[1])


class TestBatchRecalculate:
    def test_empty_sessions(self):
        ratings, games = batch_recalculate_elo([])
        assert ratings == {}
        assert games == {}

    def test_single_session(self):
        sessions = [(1, {1: 10, 2: 5})]
        ratings, games = batch_recalculate_elo(sessions)
        assert ratings[1] > 1500.0
        assert ratings[2] < 1500.0
        assert games[1] == 1
        assert games[2] == 1

    def test_chronological_order(self):
        sessions = [
            (1, {1: 10, 2: 5}),
            (2, {1: 5, 2: 10}),
        ]
        ratings, games = batch_recalculate_elo(sessions)
        # After split, ratings should be closer to 1500 than a 2-0 sweep
        assert games[1] == 2
        assert games[2] == 2

    def test_skips_unscored(self):
        sessions = [
            (1, {1: 10, 2: 5}),
            (2, {}),  # no scores
            (3, {1: 10, 2: 5}),
        ]
        ratings, games = batch_recalculate_elo(sessions)
        assert games[1] == 2
        assert games[2] == 2
