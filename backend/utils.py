import hashlib
import ipaddress
import json
import logging
import mimetypes
import os
import socket
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, List, Tuple, Optional, Set

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from constants import ALLOWED_IMAGE_EXTENSIONS

logger = logging.getLogger("cardboard.utils")

if TYPE_CHECKING:
    import models


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


def _validate_resolved_ip(url: str) -> bool:
    """Re-validate the resolved IP at request time to guard against DNS rebinding."""
    try:
        hostname = urllib.parse.urlparse(url).hostname or ""
        if not hostname:
            return False
        try:
            ip = ipaddress.ip_address(hostname)
            return not (ip.is_private or ip.is_loopback or ip.is_link_local
                        or ip.is_unspecified or ip.is_multicast)
        except ValueError:
            pass
        try:
            results = socket.getaddrinfo(hostname, None)
        except (socket.gaierror, socket.timeout, OSError):
            return False
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


class _SSRFSafeHandler(urllib.request.BaseHandler):
    """Handler that re-validates the resolved IP at request time to guard against DNS rebinding."""
    handler_order = 300  # before the default openers

    def default_open(self, req):
        if not _validate_resolved_ip(req.full_url):
            raise urllib.error.URLError("SSRF protection: resolved IP failed safety check")
        return None  # return None to let other handlers process


def build_safe_opener(context=None):
    """Build an urllib OpenerDirector that validates redirect targets and re-validates IPs."""
    handlers = [_SafeRedirectHandler(), _SSRFSafeHandler()]
    if context is not None:
        handlers.insert(0, urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener(*handlers)


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
