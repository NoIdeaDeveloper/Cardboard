"""Tests for the get_client_ip helper and trusted-proxy X-Forwarded-For handling."""
import pytest

import utils


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, peer: str, xff: str = None):
        self.client = _FakeClient(peer)
        self.headers = {}
        if xff is not None:
            self.headers["x-forwarded-for"] = xff


@pytest.fixture(autouse=True)
def _restore_trusted_proxies():
    original = utils._TRUSTED_PROXIES
    yield
    utils._TRUSTED_PROXIES = original


def _set_trusted(proxies: list[str]):
    utils._TRUSTED_PROXIES = frozenset(proxies)


def test_no_trusted_proxies_uses_peer():
    """Without TRUSTED_PROXIES, the direct peer IP is used (XFF ignored)."""
    utils._TRUSTED_PROXIES = frozenset()
    req = _FakeRequest(peer="203.0.113.5", xff="198.51.100.1")
    assert utils.get_client_ip(req) == "203.0.113.5"


def test_trusted_proxy_uses_xff():
    """When the peer is a trusted proxy, XFF leftmost entry is used."""
    _set_trusted(["10.0.0.1"])
    req = _FakeRequest(peer="10.0.0.1", xff="198.51.100.1, 10.0.0.1")
    assert utils.get_client_ip(req) == "198.51.100.1"


def test_untrusted_peer_ignores_xff():
    """XFF from a non-trusted peer is ignored (prevents spoofing)."""
    _set_trusted(["10.0.0.1"])
    req = _FakeRequest(peer="203.0.113.5", xff="198.51.100.1")
    assert utils.get_client_ip(req) == "203.0.113.5"


def test_trusted_proxy_no_xff_falls_back_to_peer():
    _set_trusted(["10.0.0.1"])
    req = _FakeRequest(peer="10.0.0.1")
    assert utils.get_client_ip(req) == "10.0.0.1"


def test_trusted_proxy_empty_xff_falls_back_to_peer():
    _set_trusted(["10.0.0.1"])
    req = _FakeRequest(peer="10.0.0.1", xff="")
    assert utils.get_client_ip(req) == "10.0.0.1"


def test_trusted_proxy_multiple_xff_uses_leftmost():
    _set_trusted(["10.0.0.1"])
    req = _FakeRequest(peer="10.0.0.1", xff="198.51.100.1, 10.0.0.2, 10.0.0.1")
    assert utils.get_client_ip(req) == "198.51.100.1"


def test_trusted_proxy_xff_with_spaces():
    _set_trusted(["10.0.0.1"])
    req = _FakeRequest(peer="10.0.0.1", xff="  198.51.100.1  , 10.0.0.1")
    assert utils.get_client_ip(req) == "198.51.100.1"


def test_no_client_returns_unknown():
    utils._TRUSTED_PROXIES = frozenset()
    req = _FakeRequest(peer=None)
    req.client = None
    assert utils.get_client_ip(req) == "unknown"


def test_multiple_trusted_proxies():
    _set_trusted(["10.0.0.1", "10.0.0.2", "172.16.0.1"])
    assert utils.get_client_ip(_FakeRequest("10.0.0.2", "198.51.100.1")) == "198.51.100.1"
    assert utils.get_client_ip(_FakeRequest("172.16.0.1", "203.0.113.9")) == "203.0.113.9"
