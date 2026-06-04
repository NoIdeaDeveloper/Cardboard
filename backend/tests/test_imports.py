"""Tests for CSV and BGG XML import endpoints."""
import io
import json
import pytest


# ---------------------------------------------------------------------------
# CSV import helpers
# ---------------------------------------------------------------------------

def _csv_upload(client, csv_text: str):
    content = csv_text.encode("utf-8")
    return client.post(
        "/api/games/import/csv",
        files={"file": ("games.csv", io.BytesIO(content), "text/csv")},
    )


# ---------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------

def test_csv_import_basic(client):
    csv_text = "name,status\nCatan,owned\nPandemic,wishlist\n"
    r = _csv_upload(client, csv_text)
    assert r.status_code == 200
    data = r.json()
    assert data["imported"] == 2
    assert data["skipped"] == 0
    assert data["errors"] == []


def test_csv_import_skips_duplicates(client):
    # Create a game first
    client.post("/api/games/", json={"name": "Catan"})
    csv_text = "name\nCatan\nTicket to Ride\n"
    r = _csv_upload(client, csv_text)
    data = r.json()
    assert data["imported"] == 1
    assert data["skipped"] == 1


def test_csv_import_skips_empty_name(client):
    # Use a row with only whitespace as the name — should be skipped
    csv_text = "name\n   \nPandemic\n"
    r = _csv_upload(client, csv_text)
    data = r.json()
    assert data["imported"] == 1
    assert data["skipped"] == 1


def test_csv_import_invalid_rating_still_imports(client):
    csv_text = "name,user_rating\n7 Wonders,not_a_number\n"
    r = _csv_upload(client, csv_text)
    data = r.json()
    assert data["imported"] == 1
    # Verify rating is None
    games = client.get("/api/games/?search=7 Wonders").json()
    assert any(g["user_rating"] is None for g in games if "7 Wonders" in g["name"])


def test_csv_import_with_tags(client):
    csv_text = "name,categories,mechanics\nImperial,Strategy;Economic,Auction;Negotiation\n"
    r = _csv_upload(client, csv_text)
    assert r.json()["imported"] == 1
    games = client.get("/api/games/?search=Imperial").json()
    assert len(games) == 1
    cats = json.loads(games[0]["categories"])
    assert "Strategy" in cats
    assert "Economic" in cats


def test_csv_import_header_only(client):
    """CSV with a header row but no data rows should succeed with 0 imports."""
    r = _csv_upload(client, "name,status\n")
    assert r.status_code == 200
    assert r.json()["imported"] == 0
    assert r.json()["skipped"] == 0


def test_csv_import_too_large(client):
    # Build a CSV > 5 MB
    big_csv = "name\n" + ("A" * 1000 + "\n") * 6000
    r = _csv_upload(client, big_csv)
    assert r.status_code == 413


def test_csv_import_malformed_encoding(client):
    # Send non-UTF-8 bytes as a CSV
    bad_bytes = b"\xff\xfe" + b"\x00" * 100  # not valid UTF-8
    r = client.post(
        "/api/games/import/csv",
        files={"file": ("bad.csv", io.BytesIO(bad_bytes), "text/csv")},
    )
    assert r.status_code == 400


def test_csv_import_partial_failure_preserves_valid_rows(client):
    """Regression: when one row fails mid-batch (savepoint rollback), other rows
    must still be committed by the final db.commit().  SQLite does not enforce
    string-length constraints, so we force a failure via mocking."""
    csv_text = (
        "name,categories\n"
        "Batch Good A,Strategy\n"
        "Batch Bad B,FailsHere\n"
        "Batch Good C,Economic\n"
    )
    # CSV import lives in routers.games.imports; patch _save_tags where the
    # endpoint resolves it (the submodule global), not on the package facade.
    import routers.games.imports as _imp
    original = _imp._save_tags

    def _failing_tags(game_id, data_dict, db):
        g = db.query(_imp.models.Game).filter(_imp.models.Game.id == game_id).first()
        if g and g.name == "Batch Bad B":
            raise Exception("Simulated tag-save failure")
        return original(game_id, data_dict, db)

    from unittest.mock import patch
    with patch.object(_imp, "_save_tags", _failing_tags):
        r = _csv_upload(client, csv_text)

    assert r.status_code == 200
    data = r.json()
    assert data["imported"] == 2, f"Expected 2 imported, got: {data}"
    assert len(data["errors"]) == 1
    assert "Batch Bad B" in str(data["errors"][0])
    # Confirm the valid rows actually exist in the collection
    games = client.get("/api/games/").json()
    names = {g["name"] for g in games}
    assert "Batch Good A" in names
    assert "Batch Good C" in names
    assert "Batch Bad B" not in names


def test_csv_notes_truncated_at_2000_chars(client):
    long_note = "X" * 3000
    csv_text = f"name,notes\nLong Notes Game,{long_note}\n"
    r = _csv_upload(client, csv_text)
    assert r.json()["imported"] == 1
    games = client.get("/api/games/?search=Long Notes Game").json()
    assert len(games[0]["user_notes"]) <= 2000


# ---------------------------------------------------------------------------
# BGG collection XML import
# ---------------------------------------------------------------------------

_BGG_COLLECTION_XML = """\
<?xml version="1.0" encoding="utf-8"?>
<items totalitems="1" termsofuse="" pubdate="">
  <item objecttype="thing" objectid="174430" subtype="boardgame" collid="1">
    <name sortindex="1">Gloomhaven</name>
    <yearpublished>2017</yearpublished>
    <stats minplayers="1" maxplayers="4" minplaytime="60" maxplaytime="120" numowned="1">
      <rating value="N/A">
        <average value="8.5"/>
      </rating>
    </stats>
    <status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" wishlist="0" preordered="0" lastmodified="2024-01-01 00:00:00"/>
  </item>
</items>
"""

_BGG_INVALID_XML = "<not valid xml<<<<"

_BGG_EMPTY_XML = '<?xml version="1.0"?><items totalitems="0"></items>'


def _bgg_upload(client, xml_text: str):
    content = xml_text.encode("utf-8")
    return client.post(
        "/api/games/import/bgg",
        files={"file": ("collection.xml", io.BytesIO(content), "text/xml")},
    )


def test_bgg_import_valid_xml(client):
    r = _bgg_upload(client, _BGG_COLLECTION_XML)
    assert r.status_code == 200
    data = r.json()
    assert data["imported"] == 1
    assert data["errors"] == []
    games = client.get("/api/games/?search=Gloomhaven").json()
    assert len(games) == 1
    assert games[0]["bgg_id"] == 174430
    assert games[0]["year_published"] == 2017


def test_bgg_import_invalid_xml(client):
    r = _bgg_upload(client, _BGG_INVALID_XML)
    assert r.status_code == 400


def test_bgg_import_no_items(client):
    r = _bgg_upload(client, _BGG_EMPTY_XML)
    assert r.status_code == 400


def test_bgg_import_skips_duplicate_name(client):
    _bgg_upload(client, _BGG_COLLECTION_XML)
    r = _bgg_upload(client, _BGG_COLLECTION_XML)
    data = r.json()
    assert data["skipped"] == 1
    assert data["imported"] == 0


def test_bgg_import_skips_duplicate_bgg_id(client):
    """Second import with same objectid but different name is skipped."""
    second_xml = _BGG_COLLECTION_XML.replace(
        "<name sortindex=\"1\">Gloomhaven</name>",
        "<name sortindex=\"1\">Gloomhaven 2nd Edition</name>",
    )
    _bgg_upload(client, _BGG_COLLECTION_XML)
    r = _bgg_upload(client, second_xml)
    data = r.json()
    assert data["skipped"] == 1


def test_bgg_import_year_out_of_range_nullified(client):
    """Years outside 1800-2099 are stored as None."""
    bad_year_xml = _BGG_COLLECTION_XML.replace(
        "<yearpublished>2017</yearpublished>",
        "<yearpublished>0</yearpublished>",
    )
    r = _bgg_upload(client, bad_year_xml)
    assert r.json()["imported"] == 1
    games = client.get("/api/games/?search=Gloomhaven").json()
    assert games[0]["year_published"] is None


def test_bgg_import_wishlist_status(client):
    """BGG items with wishlist=1 and own=0 must be imported with status='wishlist'."""
    wishlist_xml = _BGG_COLLECTION_XML.replace(
        'own="1"', 'own="0"', 1
    ).replace(
        'wishlist="0"', 'wishlist="1"', 1
    )
    r = _bgg_upload(client, wishlist_xml)
    assert r.json()["imported"] == 1
    games = client.get("/api/games/?search=Gloomhaven").json()
    assert games[0]["status"] == "wishlist"


def test_bgg_import_maps_player_counts(client):
    """min_players and max_players from the <stats> element must be saved."""
    r = _bgg_upload(client, _BGG_COLLECTION_XML)
    assert r.json()["imported"] == 1
    game = client.get("/api/games/?search=Gloomhaven").json()[0]
    assert game["min_players"] == 1
    assert game["max_players"] == 4


# ---------------------------------------------------------------------------
# BGG plays XML import
# ---------------------------------------------------------------------------

_BGG_PLAYS_XML = """\
<?xml version="1.0" encoding="utf-8"?>
<plays username="testuser" userid="1" total="1" page="1" termsofuse="">
  <play id="1" date="2024-03-10" quantity="1" length="90" incomplete="0" nowinstats="1" location="">
    <item name="Gloomhaven" objecttype="thing" objectid="174430"/>
    <players/>
  </play>
</plays>
"""


def test_bgg_plays_import(client):
    # First import the game so it can be matched
    _bgg_upload(client, _BGG_COLLECTION_XML)
    r = client.post(
        "/api/games/import/bgg-plays",
        files={"file": ("plays.xml", io.BytesIO(_BGG_PLAYS_XML.encode()), "text/xml")},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["imported"] == 1
    # Verify last_played was updated
    games = client.get("/api/games/?search=Gloomhaven").json()
    assert games[0]["last_played"] == "2024-03-10"


def test_bgg_plays_import_skips_unknown_game(client):
    r = client.post(
        "/api/games/import/bgg-plays",
        files={"file": ("plays.xml", io.BytesIO(_BGG_PLAYS_XML.encode()), "text/xml")},
    )
    data = r.json()
    assert data["skipped"] == 1
    assert data["imported"] == 0


def test_bgg_plays_import_invalid_xml(client):
    """Malformed XML in a plays file must return 400."""
    r = client.post(
        "/api/games/import/bgg-plays",
        files={"file": ("plays.xml", io.BytesIO(b"<not valid xml<<<<"), "text/xml")},
    )
    assert r.status_code == 400


def test_bgg_plays_import_no_plays(client):
    """Valid XML with no <play> records must return 400."""
    empty_plays = '<?xml version="1.0"?><plays username="x" total="0" page="1"></plays>'
    r = client.post(
        "/api/games/import/bgg-plays",
        files={"file": ("plays.xml", io.BytesIO(empty_plays.encode()), "text/xml")},
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# BGG rate limiter
# ---------------------------------------------------------------------------

def test_bgg_rate_limiter_returns_429_after_limit(client):
    """After 10 rapid requests the IP-based rate limiter must return 429."""
    import routers.games as _gmod
    _gmod._bgg_buckets.clear()

    try:
        statuses = []
        for i in range(10):
            r = client.get("/api/games/bgg-search?q=test")
            statuses.append(r.status_code)

        assert all(s != 429 for s in statuses), (
            f"Rate limit triggered prematurely on request #{statuses.index(429)+1}"
        )

        r = client.get("/api/games/bgg-search?q=test")
        assert r.status_code == 429, f"Expected 429, got {r.status_code}: {r.text}"
    finally:
        _gmod._bgg_buckets.clear()
