"""
Tests for main app-level concerns: security headers, robots.txt, robots meta.
"""


def test_robots_txt_endpoint(client):
    r = client.get("/robots.txt")
    assert r.status_code == 200
    assert "text/plain" in r.headers.get("content-type", "")
    body = r.text
    assert "User-agent: *" in body
    assert "Disallow: /" in body


def test_x_robots_tag_header_on_api(client):
    r = client.get("/api/games")
    assert r.headers.get("X-Robots-Tag") == "noindex, nofollow"


def test_x_robots_tag_header_on_health(client):
    r = client.get("/health")
    assert r.headers.get("X-Robots-Tag") == "noindex, nofollow"


def test_x_robots_tag_header_on_robots_txt(client):
    r = client.get("/robots.txt")
    assert r.headers.get("X-Robots-Tag") == "noindex, nofollow"


def test_docs_disabled_by_default(client):
    """API docs should be disabled by default (ENABLE_DOCS not set in tests)."""
    assert client.get("/api/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_csp_header_no_nonce(client):
    """CSP must not use a nonce (frontend has no inline scripts) or expose X-CSP-Nonce."""
    r = client.get("/health")
    csp = r.headers.get("content-security-policy", "")
    assert "script-src 'self'" in csp
    assert "nonce-" not in csp
    assert "x-csp-nonce" not in {k.lower() for k in r.headers.keys()}


def test_csp_header_present_on_api(client):
    r = client.get("/api/games")
    csp = r.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "img-src 'self' data: blob: https:" in csp


def test_hsts_header_present(client):
    """HSTS header should be set on all responses as belt-and-suspenders for TLS."""
    r = client.get("/health")
    hsts = r.headers.get("strict-transport-security", "")
    assert "max-age=63072000" in hsts
    assert "includeSubDomains" in hsts
