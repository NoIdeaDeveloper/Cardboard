"""Tests for database indexes added for performance."""
import sqlalchemy as sa


def _index_names(db, table):
    """Return the set of index names on a table."""
    rows = db.execute(sa.text(f"PRAGMA index_list({table})")).fetchall()
    # SQLite: row[1] is the index name
    return {r[1] for r in rows}


def test_play_sessions_played_at_index(db):
    """The played_at column must be indexed for time-bucketed stats queries."""
    indexes = _index_names(db, "play_sessions")
    assert "ix_play_sessions_played_at" in indexes


def test_junction_table_non_leading_fk_indexes(db):
    """The non-leading FK of each tag junction table must be indexed so that
    reverse-direction aggregation queries (JOIN pivot ON pivot.*_id = tag.id)
    don't require a full table scan."""
    expected = [
        ("game_categories", "ix_game_categories_category_id"),
        ("game_mechanics",  "ix_game_mechanics_mechanic_id"),
        ("game_designers",  "ix_game_designers_designer_id"),
        ("game_publishers", "ix_game_publishers_publisher_id"),
        ("game_labels",     "ix_game_labels_label_id"),
    ]
    for table, index_name in expected:
        indexes = _index_names(db, table)
        assert index_name in indexes, f"{index_name} missing from {table}"


def test_session_players_player_id_index(db):
    """The player_id column must be indexed for per-player session lookups."""
    indexes = _index_names(db, "session_players")
    assert "ix_session_players_player_id" in indexes

