"""
Tests for user settings key-value store endpoints.
"""
import logging

import pytest


def test_get_setting_returns_default_for_unknown_key(client):
    r = client.get("/api/settings/cardboard_nonexistent")
    assert r.status_code == 200
    data = r.json()
    assert data["key"] == "cardboard_nonexistent"
    assert data["value"] == ""


def test_put_and_get_setting_roundtrip(client):
    r = client.put(
        "/api/settings/cardboard_my_setting",
        json={"value": "hello world"},
    )
    assert r.status_code == 204

    r = client.get("/api/settings/cardboard_my_setting")
    assert r.status_code == 200
    data = r.json()
    assert data["key"] == "cardboard_my_setting"
    assert data["value"] == "hello world"


def test_put_setting_overwrites_existing(client):
    client.put("/api/settings/cardboard_theme", json={"value": "dark"})
    client.put("/api/settings/cardboard_theme", json={"value": "light"})

    r = client.get("/api/settings/cardboard_theme")
    assert r.status_code == 200
    assert r.json()["value"] == "light"


def test_put_settings_persist_across_gets(client):
    client.put("/api/settings/cardboard_tour_done", json={"value": "1"})
    client.put("/api/settings/cardboard_username", json={"value": "Alice"})

    r1 = client.get("/api/settings/cardboard_tour_done")
    r2 = client.get("/api/settings/cardboard_username")
    assert r1.json()["value"] == "1"
    assert r2.json()["value"] == "Alice"


def test_setting_value_max_length(client):
    val = "x" * 10000
    client.put("/api/settings/cardboard_long_val", json={"value": val})
    r = client.get("/api/settings/cardboard_long_val")
    assert len(r.json()["value"]) == 10000


def test_put_setting_value_exceeds_max_length(client):
    """Value longer than 10,000 characters must be rejected with 422."""
    r = client.put("/api/settings/cardboard_too_long", json={"value": "x" * 10_001})
    assert r.status_code == 422


def test_put_setting_empty_value(client):
    """Empty string is a valid setting value that can overwrite a previous one."""
    client.put("/api/settings/cardboard_clearable", json={"value": "initial"})
    client.put("/api/settings/cardboard_clearable", json={"value": ""})
    r = client.get("/api/settings/cardboard_clearable")
    assert r.status_code == 200
    assert r.json()["value"] == ""


def test_get_setting_key_isolation(client):
    """Two different keys never share values."""
    client.put("/api/settings/cardboard_key_a", json={"value": "alpha"})
    client.put("/api/settings/cardboard_key_b", json={"value": "beta"})
    assert client.get("/api/settings/cardboard_key_a").json()["value"] == "alpha"
    assert client.get("/api/settings/cardboard_key_b").json()["value"] == "beta"


def test_put_setting_does_not_log_value(client, caplog):
    """Setting values must not be logged verbatim — only key and length."""
    secret_value = "super-secret-token-do-not-log"
    with caplog.at_level(logging.INFO, logger="cardboard.settings"):
        client.put("/api/settings/cardboard_api_key", json={"value": secret_value})
    # The key may appear in logs, the value must not.
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "cardboard_api_key" in logged
    assert secret_value not in logged
    assert f"len={len(secret_value)}" in logged


def test_put_setting_rejects_key_without_prefix(client):
    r = client.put("/api/settings/theme", json={"value": "dark"})
    assert r.status_code == 400


def test_get_setting_rejects_key_without_prefix(client):
    r = client.get("/api/settings/theme")
    assert r.status_code == 400


def test_put_setting_rejects_long_key(client):
    key = "cardboard_" + "a" * 100
    r = client.put(f"/api/settings/{key}", json={"value": "x"})
    assert r.status_code == 400
