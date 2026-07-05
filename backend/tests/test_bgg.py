"""Tests for BGG description HTML sanitization and the sanitize_html_to_text helper."""
import xml.etree.ElementTree as ET

from utils import sanitize_html_to_text
from routers.games.bgg import _parse_bgg_item


# ---------------------------------------------------------------------------
# sanitize_html_to_text unit tests
# ---------------------------------------------------------------------------

def test_sanitize_strips_script_tags():
    html_str = '<script>alert("xss")</script>Hello world'
    assert sanitize_html_to_text(html_str) == "Hello world"


def test_sanitize_strips_event_handlers():
    html_str = '<img src=x onerror="alert(1)">Nice image'
    assert sanitize_html_to_text(html_str) == "Nice image"


def test_sanitize_strips_style_tags():
    html_str = '<style>body{color:red}</style>Visible text'
    assert sanitize_html_to_text(html_str) == "Visible text"


def test_sanitize_strips_all_tags_preserves_text():
    html_str = '<b>Bold</b> and <i>italic</i> and <a href="http://evil.com">link</a>'
    assert sanitize_html_to_text(html_str) == "Bold and italic and link"


def test_sanitize_unescapes_entities():
    html_str = "Tom &amp; Jerry &lt;3 &#39;quotes&#39;"
    result = sanitize_html_to_text(html_str)
    assert "&" in result
    assert "<" in result
    assert "'" in result
    assert "amp" not in result


def test_sanitize_collapses_whitespace():
    html_str = "<p>Line 1</p>\n\n<p>Line 2</p>"
    assert sanitize_html_to_text(html_str) == "Line 1 Line 2"


def test_sanitize_empty_input():
    assert sanitize_html_to_text("") == ""
    assert sanitize_html_to_text(None) == ""


def test_sanitize_javascript_url_in_href_stripped():
    html_str = '<a href="javascript:alert(1)">click</a> ok'
    assert sanitize_html_to_text(html_str) == "click ok"


def test_sanitize_strips_comments():
    html_str = "<!-- secret comment -->visible"
    assert sanitize_html_to_text(html_str) == "visible"


# ---------------------------------------------------------------------------
# _parse_bgg_item description sanitization
# ---------------------------------------------------------------------------

def _make_bgg_item(description_text: str) -> ET.Element:
    """Build a minimal BGG <item> XML element with the given description.

    BGG serves description HTML entity-escaped within the XML text node
    (e.g. ``&lt;script&gt;``), so we escape it the same way here.
    """
    import html as _html
    escaped = _html.escape(description_text, quote=False)
    xml = f"""<item type="thing" id="1">
        <name type="primary" value="Test Game"/>
        <description>{escaped}</description>
        <yearpublished value="2020"/>
        <minplayers value="2"/>
        <maxplayers value="4"/>
        <minplaytime value="30"/>
        <maxplaytime value="60"/>
    </item>"""
    return ET.fromstring(xml)


def test_parse_bgg_item_strips_script_from_description():
    item = _make_bgg_item('<script>alert("xss")</script>A great game.')
    data = _parse_bgg_item(item)
    assert data["description"] == "A great game."
    assert "script" not in (data["description"] or "")


def test_parse_bgg_item_strips_tags_from_description():
    item = _make_bgg_item("<b>Exciting</b> <i>card</i> game with <a href='x'>link</a>")
    data = _parse_bgg_item(item)
    assert data["description"] == "Exciting card game with link"


def test_parse_bgg_item_description_none_when_empty():
    item = _make_bgg_item("")
    data = _parse_bgg_item(item)
    assert data["description"] is None


def test_parse_bgg_item_strips_event_handler_from_description():
    item = _make_bgg_item('<img src=x onerror="alert(1)">Great game')
    data = _parse_bgg_item(item)
    assert data["description"] == "Great game"
    assert "onerror" not in (data["description"] or "")
