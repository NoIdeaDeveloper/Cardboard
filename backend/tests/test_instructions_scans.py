"""Tests for instructions file endpoints."""
import io

import pytest


def _make_game(client, name="Test Game"):
    r = client.post("/api/games/", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _upload_instructions(client, game_id, content=b"%PDF-1.4 fake pdf content", filename="manual.pdf"):
    return client.post(
        f"/api/games/{game_id}/instructions",
        files={"file": (filename, io.BytesIO(content), "application/pdf")},
    )


# ---------------------------------------------------------------------------
# Instructions
# ---------------------------------------------------------------------------

def test_upload_instructions_pdf(client):
    gid = _make_game(client)
    r = _upload_instructions(client, gid, filename="manual.pdf")
    assert r.status_code == 204
    game = client.get(f"/api/games/{gid}").json()
    assert game["instructions_filename"] == "manual.pdf"


def test_upload_instructions_txt(client):
    gid = _make_game(client)
    r = _upload_instructions(client, gid, content=b"plain text rules", filename="rules.txt")
    assert r.status_code == 204
    game = client.get(f"/api/games/{gid}").json()
    assert game["instructions_filename"] == "rules.txt"


def test_upload_instructions_wrong_extension(client):
    gid = _make_game(client)
    r = _upload_instructions(client, gid, filename="manual.docx")
    assert r.status_code == 400


def test_upload_instructions_too_large(client):
    gid = _make_game(client)
    # 20 MB + 1 byte
    big = b"x" * (20 * 1024 * 1024 + 1)
    r = _upload_instructions(client, gid, content=big)
    assert r.status_code == 413


def test_upload_instructions_game_not_found(client):
    r = _upload_instructions(client, 99999)
    assert r.status_code == 404


def test_upload_instructions_replaces_existing(client):
    gid = _make_game(client)
    _upload_instructions(client, gid, filename="v1.pdf")
    r = _upload_instructions(client, gid, filename="v2.pdf")
    assert r.status_code == 204
    game = client.get(f"/api/games/{gid}").json()
    assert game["instructions_filename"] == "v2.pdf"


def test_get_instructions(client):
    gid = _make_game(client)
    _upload_instructions(client, gid, content=b"%PDF content", filename="rules.pdf")
    r = client.get(f"/api/games/{gid}/instructions")
    assert r.status_code == 200
    assert "rules.pdf" in r.headers.get("content-disposition", "")


def test_get_instructions_not_found(client):
    gid = _make_game(client)
    r = client.get(f"/api/games/{gid}/instructions")
    assert r.status_code == 404


def test_delete_instructions(client):
    gid = _make_game(client)
    _upload_instructions(client, gid)
    r = client.delete(f"/api/games/{gid}/instructions")
    assert r.status_code == 204
    game = client.get(f"/api/games/{gid}").json()
    assert game["instructions_filename"] is None


def test_delete_instructions_not_found(client):
    gid = _make_game(client)
    r = client.delete(f"/api/games/{gid}/instructions")
    assert r.status_code == 404
