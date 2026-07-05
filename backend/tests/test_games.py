"""Tests for game CRUD, list/search/sort, tag roundtrip, and expansion logic."""
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_game(client, name="Catan", **kwargs):
    return client.post("/api/games/", json={"name": name, **kwargs})


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------

def test_create_game_minimal(client):
    r = _create_game(client)
    assert r.status_code == 201
    data = r.json()
    assert data["id"] > 0
    assert data["name"] == "Catan"
    assert data["status"] == "owned"


def test_create_game_full(client):
    r = _create_game(
        client,
        name="Wingspan",
        status="wishlist",
        year_published=2019,
        min_players=1,
        max_players=5,
        user_rating=9.0,
        bgg_id=266192,
    )
    assert r.status_code == 201
    data = r.json()
    assert data["year_published"] == 2019
    assert data["bgg_id"] == 266192
    assert data["user_rating"] == 9.0


def test_create_game_duplicate_name_case_insensitive(client):
    _create_game(client, name="Ticket to Ride")
    r = _create_game(client, name="ticket to ride")
    assert r.status_code == 409


def test_create_game_duplicate_bgg_id(client):
    _create_game(client, name="Game A", bgg_id=12345)
    r = _create_game(client, name="Game B", bgg_id=12345)
    assert r.status_code == 409


def test_create_game_invalid_status(client):
    r = _create_game(client, name="Bad Status", status="unknown")
    assert r.status_code == 422


def test_create_game_invalid_rating(client):
    r = _create_game(client, name="Bad Rating", user_rating=11)
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def test_get_game(client):
    created = _create_game(client, name="Azul").json()
    r = client.get(f"/api/games/{created['id']}")
    assert r.status_code == 200
    assert r.json()["name"] == "Azul"


def test_get_game_not_found(client):
    r = client.get("/api/games/99999")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------

def test_update_game(client):
    game_id = _create_game(client, name="Pandemic").json()["id"]
    r = client.patch(f"/api/games/{game_id}", json={"user_rating": 8.5, "status": "sold"})
    assert r.status_code == 200
    data = r.json()
    assert data["user_rating"] == 8.5
    assert data["status"] == "sold"
    assert data["name"] == "Pandemic"  # unmodified field preserved


def test_update_game_invalid_rating(client):
    game_id = _create_game(client, name="Scrabble").json()["id"]
    r = client.patch(f"/api/games/{game_id}", json={"user_rating": 11})
    assert r.status_code == 422


def test_update_game_invalid_status(client):
    game_id = _create_game(client, name="Chess").json()["id"]
    r = client.patch(f"/api/games/{game_id}", json={"status": "rented"})
    assert r.status_code == 422


def test_update_game_not_found(client):
    r = client.patch("/api/games/99999", json={"user_rating": 5})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------

def test_delete_game(client):
    game_id = _create_game(client, name="Go").json()["id"]
    r = client.delete(f"/api/games/{game_id}")
    assert r.status_code == 204
    assert client.get(f"/api/games/{game_id}").status_code == 404


def test_delete_game_detaches_expansions(client):
    parent_id = _create_game(client, name="Dominion").json()["id"]
    exp_id = _create_game(client, name="Dominion: Intrigue", parent_game_id=parent_id).json()["id"]
    client.delete(f"/api/games/{parent_id}")
    exp = client.get(f"/api/games/{exp_id}").json()
    assert exp["parent_game_id"] is None


# ---------------------------------------------------------------------------
# Expansion validation
# ---------------------------------------------------------------------------

def test_expansion_self_reference(client):
    game_id = _create_game(client, name="Gloomhaven").json()["id"]
    r = client.patch(f"/api/games/{game_id}", json={"parent_game_id": game_id})
    assert r.status_code == 400


def test_expansion_cannot_be_parent_of_another(client):
    """An expansion cannot be set as parent of another game (no nesting)."""
    parent_id = _create_game(client, name="Base Game").json()["id"]
    exp_id = _create_game(client, name="Expansion 1", parent_game_id=parent_id).json()["id"]
    child_id = _create_game(client, name="Expansion 2").json()["id"]
    r = client.patch(f"/api/games/{child_id}", json={"parent_game_id": exp_id})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# List / search / sort / filter
# ---------------------------------------------------------------------------

def test_list_games_returns_all(client):
    _create_game(client, name="Alpha")
    _create_game(client, name="Beta")
    r = client.get("/api/games/")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Alpha" in names and "Beta" in names


def test_list_games_search(client):
    _create_game(client, name="Chess Odyssey")
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=chess")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Chess Odyssey" in names
    assert "Monopoly" not in names


def test_list_games_search_matches_designer(client):
    _create_game(client, name="Wingspan", designers='["Elizabeth Hargrave"]')
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=hargrave")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Wingspan" in names
    assert "Monopoly" not in names


def test_list_games_search_matches_mechanic(client):
    _create_game(client, name="Dominion", mechanics='["Deck Building"]')
    _create_game(client, name="Monopoly", mechanics='["Roll and Move"]')
    r = client.get("/api/games/?search=deck%20building")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Dominion" in names
    assert "Monopoly" not in names


def test_list_games_search_matches_category(client):
    _create_game(client, name="Twilight Imperium", categories='["Space Exploration"]')
    _create_game(client, name="Monopoly", categories='["Economic"]')
    r = client.get("/api/games/?search=space")
    names = [g["name"] for g in r.json()]
    assert "Twilight Imperium" in names
    assert "Monopoly" not in names


def test_list_games_search_drops_short_stopwords(client):
    """Tokens shorter than 2 chars (e.g. 'a', 'I') don't break the search."""
    _create_game(client, name="Settlers of Catan")
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=a%20catan")
    names = [g["name"] for g in r.json()]
    assert "Settlers of Catan" in names
    assert "Monopoly" not in names


def test_list_games_search_fts_substring(client):
    """FTS5 matches 'Catan' inside 'Settlers of Catan' via token matching."""
    _create_game(client, name="Settlers of Catan")
    _create_game(client, name="Risk")
    r = client.get("/api/games/?search=catan")
    names = [g["name"] for g in r.json()]
    assert "Settlers of Catan" in names
    assert "Risk" not in names


def test_list_games_search_fts_multi_word(client):
    """Multi-word search: both tokens must match (FTS5 implicit AND)."""
    _create_game(client, name="Settlers of Catan")
    _create_game(client, name="Catan Junior")
    _create_game(client, name="Risk")
    r = client.get("/api/games/?search=settlers%20catan")
    names = [g["name"] for g in r.json()]
    assert "Settlers of Catan" in names
    assert "Catan Junior" not in names
    assert "Risk" not in names


def test_list_games_search_fts_prefix(client):
    """FTS5 prefix matching: 'wing*' matches 'Wingspan'."""
    _create_game(client, name="Wingspan")
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=wing")
    names = [g["name"] for g in r.json()]
    assert "Wingspan" in names
    assert "Monopoly" not in names


def test_list_games_search_fts_case_insensitive(client):
    """FTS5 search is case-insensitive."""
    _create_game(client, name="Wingspan")
    r = client.get("/api/games/?search=WINGSPAN")
    names = [g["name"] for g in r.json()]
    assert "Wingspan" in names


def test_list_games_search_matches_publisher(client):
    _create_game(client, name="Wingspan", publishers='["Stonemaier Games"]')
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=stonemaier")
    names = [g["name"] for g in r.json()]
    assert "Wingspan" in names
    assert "Monopoly" not in names


def test_list_games_search_matches_label(client):
    _create_game(client, name="Wingspan", labels='["engine builder"]')
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=engine")
    names = [g["name"] for g in r.json()]
    assert "Wingspan" in names
    assert "Monopoly" not in names


def test_list_games_search_matches_edition(client):
    _create_game(client, name="Catan", edition="Trade Edition")
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=trade")
    names = [g["name"] for g in r.json()]
    assert "Catan" in names
    assert "Monopoly" not in names


def test_list_games_search_matches_user_notes(client):
    _create_game(client, name="Wingspan", user_notes="Birthday gift from Sarah")
    _create_game(client, name="Monopoly")
    r = client.get("/api/games/?search=sarah")
    names = [g["name"] for g in r.json()]
    assert "Wingspan" in names
    assert "Monopoly" not in names


def test_search_suggestions_returns_close_matches(client):
    _create_game(client, name="Wingspan")
    _create_game(client, name="Root")
    _create_game(client, name="Catan")
    r = client.get("/api/games/search/suggestions?q=wingspon")
    assert r.status_code == 200
    suggestions = r.json()["suggestions"]
    assert "Wingspan" in suggestions


def test_search_suggestions_empty_for_short_query(client):
    _create_game(client, name="Wingspan")
    r = client.get("/api/games/search/suggestions?q=w")
    assert r.status_code == 200
    assert r.json()["suggestions"] == []


def test_search_suggestions_no_match(client):
    _create_game(client, name="Wingspan")
    r = client.get("/api/games/search/suggestions?q=zzzzzzzzzzz")
    assert r.status_code == 200
    assert r.json()["suggestions"] == []


def test_list_games_contains_multiple_statuses(client):
    _create_game(client, name="Owned Game", status="owned")
    _create_game(client, name="Wishlist Game", status="wishlist")
    r = client.get("/api/games/")
    assert r.status_code == 200
    statuses = {g["status"] for g in r.json()}
    assert "owned" in statuses
    assert "wishlist" in statuses


def test_list_games_exclude_expansions(client):
    parent_id = _create_game(client, name="Root").json()["id"]
    _create_game(client, name="Root: Underworld", parent_game_id=parent_id)
    r = client.get("/api/games/?include_expansions=false")
    names = [g["name"] for g in r.json()]
    assert "Root: Underworld" not in names
    assert "Root" in names


# ---------------------------------------------------------------------------
# Tag roundtrip
# ---------------------------------------------------------------------------

def test_tag_roundtrip(client):
    """Tags set via categories JSON are retrievable via junction tables."""
    r = _create_game(client, name="7 Wonders", categories='["Strategy", "Card Game"]')
    assert r.status_code == 201
    game_id = r.json()["id"]
    got = client.get(f"/api/games/{game_id}").json()
    # categories field should be a JSON string of the list
    import json
    cats = json.loads(got["categories"])
    assert "Strategy" in cats
    assert "Card Game" in cats


# ---------------------------------------------------------------------------
# limit cap (PERF-H9)
# ---------------------------------------------------------------------------

def test_list_games_limit_capped_at_500(client):
    """limit > 500 must be rejected with 422."""
    r = client.get("/api/games/?limit=501")
    assert r.status_code == 422


def test_list_games_limit_500_accepted(client):
    """limit=500 is the maximum allowed and should return 200."""
    _create_game(client, name="Game A")
    r = client.get("/api/games/?limit=500")
    assert r.status_code == 200


def test_list_games_limit_with_offset(client):
    """limit + offset pagination returns correct slice and X-Total-Count."""
    for name in ["A", "B", "C", "D", "E"]:
        _create_game(client, name=name)
    r = client.get("/api/games/?limit=2&offset=1&sort_by=name&sort_dir=asc")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert names == ["B", "C"]
    assert r.headers["X-Total-Count"] == "5"


# ---------------------------------------------------------------------------
# check-duplicate (PERF-M4: SQL-filtered candidates)
# ---------------------------------------------------------------------------

def test_check_duplicate_exact_name(client):
    _create_game(client, name="Wingspan")
    r = client.get("/api/games/check-duplicate", params={"name": "Wingspan"})
    assert r.status_code == 200
    dups = r.json()["duplicates"]
    assert len(dups) == 1
    assert dups[0]["reason"] == "exact_name"


def test_check_duplicate_bgg_id(client):
    _create_game(client, name="Some Game", bgg_id=12345)
    r = client.get("/api/games/check-duplicate", params={"name": "Different Name", "bgg_id": 12345})
    assert r.status_code == 200
    dups = r.json()["duplicates"]
    assert any(d["reason"] == "same_bgg_id" for d in dups)


def test_check_duplicate_no_match(client):
    _create_game(client, name="Wingspan")
    r = client.get("/api/games/check-duplicate", params={"name": "Monopoly"})
    assert r.status_code == 200
    assert r.json()["duplicates"] == []


def test_check_duplicate_substring_candidate(client):
    """SQL LIKE filter finds games containing the search term."""
    _create_game(client, name="Settlers of Catan")
    r = client.get("/api/games/check-duplicate", params={"name": "Catan"})
    assert r.status_code == 200
    dups = r.json()["duplicates"]
    assert len(dups) >= 1
    assert any("Catan" in d["name"] for d in dups)


# ---------------------------------------------------------------------------
# New filters: labels, designers, publishers, condition, loaned, price range
# ---------------------------------------------------------------------------

def test_list_games_filter_labels(client):
    _create_game(client, name="Catan", labels='["Family"]')
    _create_game(client, name="Gloomhaven", labels='["Heavy"]')
    r = client.get("/api/games/?labels=Family")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Catan" in names
    assert "Gloomhaven" not in names


def test_list_games_filter_designers(client):
    _create_game(client, name="Catan", designers='["Klaus Teuber"]')
    _create_game(client, name="Wingspan", designers='["Elizabeth Hargrove"]')
    r = client.get("/api/games/?designers=Klaus%20Teuber")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Catan" in names
    assert "Wingspan" not in names


def test_list_games_filter_publishers(client):
    _create_game(client, name="Catan", publishers='["Kosmos"]')
    _create_game(client, name="Wingspan", publishers='["Stonemaier"]')
    r = client.get("/api/games/?publishers=Kosmos")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Catan" in names
    assert "Wingspan" not in names


def test_list_games_filter_condition(client):
    _create_game(client, name="Catan", condition="Good")
    _create_game(client, name="Monopoly", condition="Poor")
    r = client.get("/api/games/?condition=Good")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Catan" in names
    assert "Monopoly" not in names


def test_list_games_filter_loaned_true(client):
    _create_game(client, name="Catan", loaned_to="Alice")
    _create_game(client, name="Risk")
    r = client.get("/api/games/?loaned=true")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Catan" in names
    assert "Risk" not in names


def test_list_games_filter_loaned_false(client):
    _create_game(client, name="Catan", loaned_to="Alice")
    _create_game(client, name="Risk")
    r = client.get("/api/games/?loaned=false")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Risk" in names
    assert "Catan" not in names


def test_list_games_filter_price_range(client):
    _create_game(client, name="Cheap", purchase_price=20.0)
    _create_game(client, name="Mid", purchase_price=50.0)
    _create_game(client, name="Pricey", purchase_price=120.0)
    r = client.get("/api/games/?price_min=30&price_max=100")
    assert r.status_code == 200
    names = [g["name"] for g in r.json()]
    assert "Mid" in names
    assert "Cheap" not in names
    assert "Pricey" not in names


# ---------------------------------------------------------------------------
# rolled_up_session_count (expansion play rollup)
# ---------------------------------------------------------------------------

def _add_session(client, game_id, played_at="2024-01-15"):
    r = client.post(f"/api/games/{game_id}/sessions", json={"played_at": played_at})
    assert r.status_code == 201
    return r.json()


def test_rolled_up_session_count_includes_expansion_plays(client):
    """Base game's rolled_up_session_count = own sessions + expansion sessions."""
    parent_id = _create_game(client, name="Wingspan").json()["id"]
    exp_id = _create_game(client, name="Wingspan: European", parent_game_id=parent_id).json()["id"]
    # 2 sessions on base, 1 on expansion
    _add_session(client, parent_id, "2024-01-01")
    _add_session(client, parent_id, "2024-02-01")
    _add_session(client, exp_id, "2024-03-01")
    r = client.get(f"/api/games/{parent_id}")
    assert r.status_code == 200
    data = r.json()
    assert data["session_count"] == 2
    assert data["rolled_up_session_count"] == 3


def test_rolled_up_session_count_no_expansions(client):
    """A game with no expansions: rolled_up == session_count."""
    gid = _create_game(client, name="Chess").json()["id"]
    _add_session(client, gid, "2024-01-01")
    r = client.get(f"/api/games/{gid}")
    data = r.json()
    assert data["session_count"] == 1
    assert data["rolled_up_session_count"] == 1


def test_rolled_up_session_count_in_list(client):
    """rolled_up_session_count is populated in list responses too."""
    parent_id = _create_game(client, name="Root").json()["id"]
    exp_id = _create_game(client, name="Root: Underworld", parent_game_id=parent_id).json()["id"]
    _add_session(client, parent_id, "2024-01-01")
    _add_session(client, exp_id, "2024-02-01")
    _add_session(client, exp_id, "2024-03-01")
    r = client.get("/api/games/?include_expansions=true")
    games = {g["name"]: g for g in r.json()}
    assert games["Root"]["rolled_up_session_count"] == 3
    assert games["Root"]["session_count"] == 1
    # Expansion's rolled_up is just its own sessions (no children)
    assert games["Root: Underworld"]["rolled_up_session_count"] == 2


def test_rolled_up_session_count_zero_when_no_plays(client):
    """No sessions at all → both counts are 0."""
    parent_id = _create_game(client, name="Pandemic").json()["id"]
    _create_game(client, name="Pandemic: On the Brink", parent_game_id=parent_id)
    r = client.get(f"/api/games/{parent_id}")
    data = r.json()
    assert data["session_count"] == 0
    assert data["rolled_up_session_count"] == 0


# ---------------------------------------------------------------------------
# POST /api/games/plan-evening — game-night sequence planner
# ---------------------------------------------------------------------------

def test_plan_evening_returns_sequence(client):
    """Plan an evening with games that fit the time budget."""
    _create_game(client, name="Quick Filler", min_playtime=15, max_playtime=20, difficulty=1.5)
    _create_game(client, name="Main Event", min_playtime=60, max_playtime=90, difficulty=3.0, user_rating=8)
    _create_game(client, name="Wind Down", min_playtime=20, max_playtime=30, difficulty=2.0)
    r = client.post("/api/games/plan-evening", json={"total_minutes": 120})
    assert r.status_code == 200
    data = r.json()
    assert data["feasible"] is True
    assert data["total_est_minutes"] <= 120
    roles = [s["role"] for s in data["slots"]]
    assert "main" in roles
    assert len(data["slots"]) >= 2


def test_plan_evening_empty_collection(client):
    """No games → infeasible with a note."""
    r = client.post("/api/games/plan-evening", json={"total_minutes": 120})
    assert r.status_code == 200
    data = r.json()
    assert data["feasible"] is False
    assert data["slots"] == []
    assert "note" in data


def test_plan_evening_tight_budget(client):
    """Very tight budget may only fit one game."""
    _create_game(client, name="Long Game", min_playtime=90, max_playtime=120)
    r = client.post("/api/games/plan-evening", json={"total_minutes": 30})
    assert r.status_code == 200
    data = r.json()
    # Long game doesn't fit; no slots
    assert data["feasible"] is False


def test_plan_evening_teach_mode(client):
    """Teach mode favors unplayed games with low complexity for the main slot."""
    # Use a quick filler so Light New isn't snatched as the opener
    _create_game(client, name="Quick Filler", min_playtime=15, max_playtime=20, difficulty=1.0)
    _create_game(client, name="Light New", min_playtime=40, max_playtime=60, difficulty=2.0)
    _create_game(client, name="Heavy Known", min_playtime=60, max_playtime=90, difficulty=4.5, user_rating=9)
    r = client.post("/api/games/plan-evening", json={"total_minutes": 180, "teach_mode": True})
    assert r.status_code == 200
    data = r.json()
    main_slot = next((s for s in data["slots"] if s["role"] == "main"), None)
    assert main_slot is not None
    # In teach mode, the light unplayed game should be preferred for the main slot
    assert main_slot["game"]["name"] == "Light New"


def test_plan_evening_player_count_filter(client):
    """Games that don't support the player count are excluded."""
    _create_game(client, name="2P Only", min_players=2, max_players=2, min_playtime=30)
    _create_game(client, name="4P Game", min_players=3, max_players=5, min_playtime=30)
    r = client.post("/api/games/plan-evening", json={"total_minutes": 120, "player_count": 4})
    assert r.status_code == 200
    data = r.json()
    names = [s["game"]["name"] for s in data["slots"]]
    assert "4P Game" in names
    assert "2P Only" not in names
