import hashlib
import html
import html.parser
import http.client
import ipaddress
import json
import logging
import mimetypes
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, List, Optional, Set, Tuple

from constants import ALLOWED_IMAGE_EXTENSIONS
from fastapi import HTTPException

# Mitigate Pillow decompression-bomb DoS: a 10 MB compressed PNG can decode to
# ~89 MP (~268 MB RAM) at Pillow's default ceiling. 8 MP is generous for board-
# game cover art while capping memory exposure per image.
from PIL import Image as _PILImage
from sqlalchemy import func
from sqlalchemy.orm import Session

_PILImage.MAX_IMAGE_PIXELS = 8_000_000

logger = logging.getLogger("cardboard.utils")

if TYPE_CHECKING:
    import models


# Trusted proxy IPs — when set via TRUSTED_PROXIES env var, X-Forwarded-For is
# respected only for requests originating from these IPs. Prevents spoofing.
_TRUSTED_PROXIES: frozenset[str] = frozenset(
    s.strip() for s in os.getenv("TRUSTED_PROXIES", "").split(",") if s.strip()
)


# Optional API key gating for destructive endpoints. When CARDBOARD_API_KEY is
# set (non-empty), destructive endpoints require an X-API-Key header that
# matches (constant-time). When unset, the app behaves as before (no auth) —
# preserving the single-user localhost experience. The stored key is hashed
# with SHA-256 so the plaintext never sits in module state longer than needed.
import secrets as _secrets

_API_KEY_ENV = os.getenv("CARDBOARD_API_KEY", "").strip()
_API_KEY_HASH: str | None = None
if _API_KEY_ENV:
    _API_KEY_HASH = hashlib.sha256(_API_KEY_ENV.encode("utf-8")).hexdigest()
    _API_KEY_ENV = ""  # drop plaintext reference
    logger.info("CARDBOARD_API_KEY set — destructive endpoints require X-API-Key header")


def require_api_key(request) -> None:
    """Enforce X-API-Key on destructive endpoints when CARDBOARD_API_KEY is set.

    Raises HTTPException(401) if the key is configured but missing/wrong; no-op
    when unconfigured (preserves the single-user localhost experience).
    """
    if _API_KEY_HASH is None:
        return  # auth disabled
    provided = request.headers.get("X-API-Key", "") if hasattr(request, "headers") else ""
    provided_hash = hashlib.sha256(provided.encode("utf-8")).hexdigest() if provided else ""
    if not provided or not _secrets.compare_digest(provided_hash, _API_KEY_HASH):
        raise HTTPException(status_code=401, detail="Valid X-API-Key required for this operation")


def get_client_ip(request) -> str:
    """Return the client IP, respecting X-Forwarded-For when behind a trusted proxy.

    Without TRUSTED_PROXIES configured, falls back to ``request.client.host``
    (the direct TCP peer). When configured and the peer is a trusted proxy,
    parses ``X-Forwarded-For`` and returns the leftmost (original client) IP.
    This prevents XFF spoofing by untrusted clients while correctly identifying
    individual clients behind a reverse proxy.
    """
    peer = request.client.host if request.client else "unknown"
    if not _TRUSTED_PROXIES or peer not in _TRUSTED_PROXIES:
        return peer
    xff = request.headers.get("x-forwarded-for", "")
    if not xff:
        return peer
    # Leftmost entry is the original client; subsequent entries are proxies.
    first = xff.split(",")[0].strip()
    return first or peer


def _is_safe_url(url: str) -> bool:
    """Return False if the URL resolves to a private, loopback, unspecified,
    multicast, or link-local IP (SSRF guard)."""
    try:
        parsed = urllib.parse.urlparse(url)
        hostname = parsed.hostname or ""
        if not hostname:
            return False
        try:
            ip = ipaddress.ip_address(hostname)  # raw IP literal
            return not (ip.is_private or ip.is_loopback or ip.is_link_local
                        or ip.is_unspecified or ip.is_multicast)
        except ValueError:
            pass
        # Resolve all addresses (IPv4 and IPv6) to guard against IPv6 SSRF
        try:
            results = socket.getaddrinfo(hostname, None)
        except (socket.gaierror, socket.timeout, OSError):
            return False  # unresolvable hostname = block
        if not results:
            return False
        for _family, _type, _proto, _canonname, sockaddr in results:
            try:
                ip = ipaddress.ip_address(sockaddr[0])
            except ValueError:
                return False
            if (ip.is_private or ip.is_loopback or ip.is_link_local
                    or ip.is_unspecified or ip.is_multicast):
                return False
        return True
    except (socket.gaierror, socket.herror, socket.timeout, ValueError, OSError):
        return False


def _resolve_and_validate_ip(hostname: str, port: int) -> Optional[str]:
    """Resolve hostname to a single safe IP address.

    Returns the first public (non-private/loopback/link-local/unspecified/
    multicast) resolved IP, or None if no safe IP is found.  This is a single
    DNS resolution — the caller pins the connection to the returned IP to
    eliminate the DNS-rebinding TOCTOU gap.
    """
    try:
        ip = ipaddress.ip_address(hostname)  # raw IP literal
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return None
        if ip.is_unspecified or ip.is_multicast:
            return None
        return hostname
    except ValueError:
        pass
    try:
        results = socket.getaddrinfo(hostname, port)
    except (socket.gaierror, socket.timeout, OSError):
        return None
    for _f, _t, _p, _c, sockaddr in results:
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
        if not (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_unspecified or ip.is_multicast):
            return sockaddr[0]
    return None


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTP connection pinned to a pre-validated IP address.

    The ``Host`` header is set by the caller via request headers so the server
    sees the correct virtual host.  This class only changes the TCP connection
    target to the validated IP.
    """

    def __init__(self, host, *, pinned_ip=None, original_hostname=None, **kwargs):
        super().__init__(pinned_ip or host, **kwargs)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection pinned to a pre-validated IP address.

    SNI and certificate validation use the original hostname, while the TCP
    connection goes to the validated IP — eliminating the DNS-rebinding TOCTOU
    gap that exists when the downstream handler re-resolves the hostname.
    """

    def __init__(self, host, *, pinned_ip=None, original_hostname=None, **kwargs):
        self._original_hostname = original_hostname
        super().__init__(pinned_ip or host, **kwargs)

    def connect(self):
        """TCP-connect to the pinned IP, but use the original hostname for SNI."""
        http.client.HTTPConnection.connect(self)
        if self._tunnel_host:
            server_hostname = self._tunnel_host
        else:
            server_hostname = self._original_hostname or self.host
        self.sock = self._context.wrap_socket(
            self.sock, server_hostname=server_hostname
        )


class _SSRFSafeHTTPHandler(urllib.request.AbstractHTTPHandler):
    """HTTP/HTTPS handler that resolves DNS once, validates the IP, and pins
    the connection to that IP — eliminating the DNS-rebinding TOCTOU gap.

    The previous approach (``_SSRFSafeHandler.default_open``) validated the
    resolved IP and then returned ``None``, letting the downstream HTTPHandler
    re-resolve the hostname and connect.  Between the check and the connect,
    a DNS record could flip to a private IP (classic DNS rebinding).  This
    handler resolves once and pins the connection to the validated IP.
    """

    handler_order = 300

    def __init__(self, ssl_context=None):
        super().__init__()
        self._ssl_context = ssl_context

    def http_open(self, req):
        return self._open_pinned(req, _PinnedHTTPConnection)

    def https_open(self, req):
        return self._open_pinned(req, _PinnedHTTPSConnection)

    def _open_pinned(self, req, conn_class):
        parsed = urllib.parse.urlparse(req.full_url)
        hostname = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if not hostname:
            raise urllib.error.URLError("SSRF protection: no hostname in URL")

        valid_ip = _resolve_and_validate_ip(hostname, port)
        if not valid_ip:
            raise urllib.error.URLError(
                f"SSRF protection: resolved IP for {hostname} failed safety check"
            )

        # Set the Host header to the original hostname so the server sees the
        # correct virtual host.  When a Host header is present in the explicit
        # request headers, http.client skips its auto-generated Host header.
        req.add_unredirected_hdr("Host", hostname)

        conn_kwargs = {"pinned_ip": valid_ip, "original_hostname": hostname}
        if conn_class is _PinnedHTTPSConnection and self._ssl_context:
            conn_kwargs["context"] = self._ssl_context

        return self.do_open(conn_class, req, **conn_kwargs)


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that validates redirect targets against the SSRF guard."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _is_safe_url(newurl):
            raise urllib.error.HTTPError(
                req.full_url, code,
                "Redirect blocked by URL safety policy",
                headers, fp,
            )
        return urllib.request.HTTPRedirectHandler.redirect_request(
            self, req, fp, code, msg, headers, newurl
        )


def build_safe_opener(context=None):
    """Build a urllib OpenerDirector with SSRF-safe HTTP/HTTPS handling.

    All outbound requests are pinned to a single validated IP per hostname,
    eliminating DNS-rebinding TOCTOU.  Redirect targets are validated against
    the same SSRF guard.
    """
    handler = _SSRFSafeHTTPHandler(ssl_context=context)
    return urllib.request.build_opener(_SafeRedirectHandler(), handler)


def validate_url_safety(url: str, max_length: int = 2000) -> Tuple[bool, Optional[str]]:
    """Validate URL safety and format.
    
    Args:
        url: URL to validate
        max_length: Maximum allowed URL length
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not url or len(url) > max_length:
        return False, "URL too long or empty"
    
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, "Only http/https URLs are supported"
    
    if not _is_safe_url(url):
        return False, "Private/loopback URLs are not permitted"
    
    return True, None


def collection_etag(db: Session) -> str:
    """Compute a stable ETag from game count + latest date_modified."""
    import models as _models
    row = db.query(func.count(_models.Game.id), func.max(_models.Game.date_modified)).first()
    return f'"{hashlib.md5(f"{row[0]}:{row[1]}".encode(), usedforsecurity=False).hexdigest()}"'


def get_game_or_404(game_id: int, db) -> "models.Game":
    """Fetch a game by ID or raise HTTP 404. Avoids repeating this 3-line pattern everywhere."""
    import models as _models
    game = db.query(_models.Game).filter(_models.Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    return game


def get_player_or_404(player_id: int, db) -> "models.Player":
    """Fetch a player by ID or raise HTTP 404."""
    import models as _models
    player = db.query(_models.Player).filter(_models.Player.id == player_id).first()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    return player


def get_session_or_404(session_id: int, db) -> "models.PlaySession":
    """Fetch a play session by ID or raise HTTP 404."""
    import models as _models
    obj = db.query(_models.PlaySession).filter(_models.PlaySession.id == session_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Session not found")
    return obj


def get_goal_or_404(goal_id: int, db) -> "models.Goal":
    """Fetch a goal by ID or raise HTTP 404."""
    import models as _models
    obj = db.query(_models.Goal).filter(_models.Goal.id == goal_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Goal not found")
    return obj


def safe_write_file(path: str, content: bytes, log_msg: str, http_detail: str) -> None:
    """Write bytes to a file, logging and raising HTTP 500 on OSError."""
    try:
        with open(path, "wb") as f:
            f.write(content)
    except OSError:
        logger.exception(log_msg)
        raise HTTPException(status_code=500, detail=http_detail)


def safe_delete_file(path: str) -> None:
    """Delete a file, silently ignoring OSError (e.g. file not found)."""
    try:
        os.remove(path)
    except OSError:
        pass


def parse_json_list(json_str: Optional[str]) -> List:
    """Safely parse a JSON-encoded list string, returning an empty list on failure."""
    try:
        return json.loads(json_str or '[]')
    except (json.JSONDecodeError, TypeError):
        return []


def validate_file_extension(filename: str, allowed: Set[str], detail: str) -> str:
    """Return the lowercased extension or raise HTTP 400 if not in the allowed set."""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=detail)
    return ext


def safe_image_ext(url: str, content_type: str, allowed: Set[str] = ALLOWED_IMAGE_EXTENSIONS) -> str:
    """Derive a safe file extension from content-type or URL, falling back to .jpg."""
    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ""
    if ext in (".jpe", ""):
        url_ext = os.path.splitext(url.split("?")[0])[1].lower()
        ext = url_ext if url_ext in allowed else ".jpg"
    if ext not in allowed:
        ext = ".jpg"
    return ext


def strip_image_metadata(content: bytes, ext: str) -> bytes:
    """Re-encode an image to strip EXIF/metadata (including GPS coordinates).

    For JPEG and WebP: re-encode with exif=b"" to strip all EXIF data.
    For PNG: re-encode without pnginfo to strip text metadata chunks.
    For GIF: pass through unchanged (no EXIF GPS risk; preserves animation).

    Returns the original bytes if re-encoding fails — better to accept an image
    with EXIF than to break an upload.
    """
    try:
        from io import BytesIO

        img = _PILImage.open(BytesIO(content))
        fmt = (img.format or "").upper()

        if fmt not in ("JPEG", "PNG", "WEBP"):
            return content

        out = BytesIO()
        if fmt == "JPEG":
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(out, "JPEG", quality=95, exif=b"")
        elif fmt == "WEBP":
            img.save(out, "WEBP", quality=95, exif=b"")
        elif fmt == "PNG":
            img.save(out, "PNG", pnginfo=None)

        stripped = out.getvalue()
        return stripped if stripped else content
    except Exception:
        logger.warning("EXIF stripping failed (ext=%s) — using original bytes", ext, exc_info=True)
        return content


def validate_image_content(content: bytes) -> bool:
    """Validate that content starts with valid image magic bytes."""
    if len(content) < 4:
        return False
    # JPEG: FF D8 FF
    if content[:3] == b'\xff\xd8\xff':
        return True
    # PNG: 89 50 4E 47
    if content[:4] == b'\x89PNG':
        return True
    # GIF: GIF87a or GIF89a
    if content[:6] in (b'GIF87a', b'GIF89a'):
        return True
    # WebP: RIFF....WEBP
    if len(content) >= 12 and content[:4] == b'RIFF' and content[8:12] == b'WEBP':
        return True
    return False


class _HTMLTagStripper(html.parser.HTMLParser):
    """Strip all HTML tags, leaving only text content.

    Drops scripts, styles, comments, and event handlers. Unescapes HTML
    entities (``&amp;`` -> ``&``) since the output is stored as plain text
    and re-escaped by the frontend at render time.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0  # track <script>/<style> depth

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._parts.append(data)

    def get_text(self) -> str:
        text = "".join(self._parts)
        text = re.sub(r"\s+", " ", text).strip()
        return text


def sanitize_html_to_text(html_str: str) -> str:
    """Sanitize untrusted HTML by stripping all tags, scripts, and handlers.

    Returns plain text safe for storage and display. The frontend already
    escapes this via ``escapeHtml()``; this is defense-in-depth so a future
    change that accidentally renders the field as HTML has nothing to execute.
    """
    if not html_str:
        return ""
    stripper = _HTMLTagStripper()
    stripper.feed(html_str)
    stripper.close()
    return stripper.get_text()
