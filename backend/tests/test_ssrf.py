"""Tests for SSRF protection and DNS-rebinding TOCTOU mitigation."""
import http.client
import socket
import urllib.error
from unittest import mock

import pytest
import utils


def test_resolve_and_validate_ip_rejects_localhost():
    assert utils._resolve_and_validate_ip("127.0.0.1", 80) is None
    assert utils._resolve_and_validate_ip("localhost", 80) is None


def test_resolve_and_validate_ip_rejects_private():
    assert utils._resolve_and_validate_ip("10.0.0.1", 80) is None
    assert utils._resolve_and_validate_ip("192.168.1.1", 80) is None
    assert utils._resolve_and_validate_ip("172.16.0.1", 80) is None


def test_resolve_and_validate_ip_accepts_raw_public_ip():
    # 8.8.8.8 is Google DNS — a stable public IP
    assert utils._resolve_and_validate_ip("8.8.8.8", 80) == "8.8.8.8"


def test_resolve_and_validate_ip_rejects_unresolvable():
    with mock.patch("socket.getaddrinfo", side_effect=socket.gaierror("no such host")):
        assert utils._resolve_and_validate_ip("nonexistent.invalid", 80) is None


def test_resolve_and_validate_ip_rejects_when_all_addresses_private():
    fake_results = [
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.5", 80)),
    ]
    with mock.patch("socket.getaddrinfo", return_value=fake_results):
        assert utils._resolve_and_validate_ip("example.com", 80) is None


def test_resolve_and_validate_ip_returns_first_public():
    fake_results = [
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.5", 80)),
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80)),  # example.com
    ]
    with mock.patch("socket.getaddrinfo", return_value=fake_results):
        assert utils._resolve_and_validate_ip("example.com", 80) == "93.184.216.34"


def test_pinned_http_connection_connects_to_pinned_ip():
    """_PinnedHTTPConnection must use pinned_ip, not the original host."""
    conn = utils._PinnedHTTPConnection(
        "example.com", pinned_ip="93.184.216.34", original_hostname="example.com"
    )
    assert conn.host == "93.184.216.34"


def test_pinned_https_connection_connects_to_pinned_ip():
    """_PinnedHTTPSConnection must use pinned_ip for TCP, hostname for SNI."""
    conn = utils._PinnedHTTPSConnection(
        "example.com", pinned_ip="93.184.216.34", original_hostname="example.com"
    )
    assert conn.host == "93.184.216.34"
    assert conn._original_hostname == "example.com"


def test_pinned_https_connection_uses_hostname_for_sni():
    """connect() must call wrap_socket with the original hostname, not the IP."""
    import ssl
    conn = utils._PinnedHTTPSConnection(
        "example.com", pinned_ip="93.184.216.34", original_hostname="example.com"
    )
    with mock.patch.object(http.client.HTTPConnection, "connect"), \
         mock.patch.object(ssl.SSLContext, "wrap_socket") as mock_wrap:
        conn.connect()
        mock_wrap.assert_called_once()
        call_kwargs = mock_wrap.call_args.kwargs
        assert call_kwargs["server_hostname"] == "example.com"


def test_ssrf_handler_blocks_private_ip():
    """The handler must raise URLError for a URL resolving to a private IP."""
    handler = utils._SSRFSafeHTTPHandler()
    req = urllib.request.Request("http://evil.test/some-path")
    fake_results = [
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.5", 80)),
    ]
    with mock.patch("socket.getaddrinfo", return_value=fake_results):
        with pytest.raises(urllib.error.URLError, match="SSRF"):
            handler.http_open(req)


def test_ssrf_handler_blocks_localhost():
    handler = utils._SSRFSafeHTTPHandler()
    req = urllib.request.Request("http://127.0.0.1/admin")
    with pytest.raises(urllib.error.URLError, match="SSRF"):
        handler.http_open(req)


def test_build_safe_opener_includes_ssrf_handler():
    """The opener must include the SSRF-safe HTTP handler."""
    opener = utils.build_safe_opener()
    has_ssrf = any(isinstance(h, utils._SSRFSafeHTTPHandler) for h in opener.handlers)
    assert has_ssrf


def test_build_safe_opener_includes_redirect_guard():
    """The opener must include the redirect-safety handler."""
    opener = utils.build_safe_opener()
    has_redirect = any(isinstance(h, utils._SafeRedirectHandler) for h in opener.handlers)
    assert has_redirect


def test_build_safe_opener_with_ssl_context():
    """The SSL context must be passed through to the handler."""
    import ssl
    ctx = ssl.create_default_context()
    opener = utils.build_safe_opener(context=ctx)
    handler = next(h for h in opener.handlers if isinstance(h, utils._SSRFSafeHTTPHandler))
    assert handler._ssl_context is ctx


# ---------------------------------------------------------------------------
# Persist-time image URL validation (defense in depth: URLs are served back to
# browsers and embedded in the static-HTML export, so internal/private URLs
# must be rejected when stored, not only when the background cache runs)
# ---------------------------------------------------------------------------

def test_create_game_rejects_private_image_url(client):
    r = client.post("/api/games/", json={"name": "Evil", "image_url": "http://169.254.169.254/meta"})
    assert r.status_code == 400


def test_create_game_rejects_private_thumbnail_url(client):
    r = client.post("/api/games/", json={"name": "Evil2", "thumbnail_url": "http://127.0.0.1/x.jpg"})
    assert r.status_code == 400


def test_create_game_accepts_public_image_url(client):
    # The background image-cache task talks to the production engine (separate
    # in-memory DB with no tables under tests) — patch it out.
    with mock.patch("routers.games.crud._cache_game_image"):
        r = client.post("/api/games/", json={"name": "Good", "image_url": "https://example.com/cover.jpg"})
    assert r.status_code == 201
    assert r.json()["image_url"] == "https://example.com/cover.jpg"


def test_update_game_rejects_private_image_url(client):
    gid = client.post("/api/games/", json={"name": "Change Me"}).json()["id"]
    r = client.patch(f"/api/games/{gid}", json={"image_url": "http://10.0.0.1/evil.jpg"})
    assert r.status_code == 400
    game = client.get(f"/api/games/{gid}").json()
    assert game["image_url"] is None  # original value untouched


def test_bgg_import_rejects_private_image_url(client):
    """A hostile BGG collection XML must not persist an internal URL."""
    evil_xml = '<?xml version="1.0" encoding="utf-8"?>' \
        '<items totalitems="1"><item objecttype="thing" objectid="1" subtype="boardgame" collid="1">' \
        '<name sortindex="1">Evil Game</name>' \
        '<yearpublished>2020</yearpublished>' \
        '<image>http://169.254.169.254/meta</image>' \
        '<stats minplayers="1" maxplayers="4"><rating value="N/A"><average value="8"/></rating></stats>' \
        '<status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" ' \
        'wishlist="0" preordered="0" lastmodified="2024-01-01 00:00:00"/></item></items>'
    import io
    r = client.post(
        "/api/games/import/bgg",
        files={"file": ("evil.xml", io.BytesIO(evil_xml.encode()), "text/xml")},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["imported"] == 1
    games = client.get("/api/games/?search=Evil Game").json()
    assert len(games) == 1
    assert games[0]["image_url"] is None


def test_bgg_parse_rejects_private_image_url():
    """_parse_bgg_item must drop image URLs pointing at internal hosts."""
    import xml.etree.ElementTree as ET

    from routers.games.bgg import _parse_bgg_item
    item = ET.fromstring(
        '<item type="thing" id="1">'
        '<name type="primary" value="Test"/>'
        '<image>http://192.168.1.1/steal.jpg</image>'
        "</item>"
    )
    data = _parse_bgg_item(item)
    assert data["image_url"] is None


def test_bgg_parse_keeps_public_image_url():
    import xml.etree.ElementTree as ET

    from routers.games.bgg import _parse_bgg_item
    item = ET.fromstring(
        '<item type="thing" id="1">'
        '<name type="primary" value="Test"/>'
        '<image>https://cf.geekdo-images.com/cover.jpg</image>'
        "</item>"
    )
    data = _parse_bgg_item(item)
    assert data["image_url"] == "https://cf.geekdo-images.com/cover.jpg"
