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
