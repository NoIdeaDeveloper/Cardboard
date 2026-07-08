"""
Tests for main app-level concerns: security headers, robots.txt, robots meta.
"""
from fastapi import APIRouter


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


def test_unhandled_exception_returns_generic_500(client, db):
    """The global exception handler must return a generic 500 with no traceback leak.

    Regression test for the security fix that prevents raw error details from
    reaching the client (CHANGELOG [Unreleased]).

    Uses a TestClient with raise_server_exceptions=False to match production
    behavior (uvicorn does not re-raise; it lets the exception handler return
    the 500 response).
    """
    from database import get_db
    from fastapi.testclient import TestClient
    from main import app

    test_router = APIRouter()

    @test_router.get("/api/boom")
    def _boom():
        raise RuntimeError("secret internal traceback must not leak")

    app.include_router(test_router)

    def _override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.get("/api/boom")
            assert r.status_code == 500
            body = r.json()
            assert body.get("detail") == "Internal server error"
            # Ensure the actual exception message does not appear in the response.
            assert "secret internal traceback" not in r.text
            assert "RuntimeError" not in r.text
            assert "Traceback" not in r.text
    finally:
        # Remove the route so it doesn't leak into other tests.
        app.router.routes = [
            route for route in app.router.routes
            if getattr(route, "path", None) != "/api/boom"
        ]
