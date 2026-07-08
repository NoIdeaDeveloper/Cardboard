"""Tests for image upload, gallery, and reorder endpoints."""
import io
import os

import pytest
from PIL import ExifTags, Image

# Minimal valid JPEG (1x1 pixel, white)
_TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t"
    b"\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a"
    b"\x1f\x1e\x1d\x1a\x1c\x1c $.' \",#\x1c\x1c(7),01444\x1f'9=82<.342\x1eF"
    b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
    b"\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00"
    b"\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b"
    b"\xff\xc4\x00\xb5\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04"
    b"\x04\x00\x00\x01}\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa"
    b"\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xfb\xd2\x8a(\x03\xff\xd9"
)


def _make_jpeg_with_exif() -> bytes:
    """Create a 4x4 JPEG with EXIF metadata (ImageDescription, Make, Software)."""
    img = Image.new("RGB", (4, 4), (255, 0, 0))
    exif = img.getexif()
    exif[0x010e] = "Private description"      # ImageDescription
    exif[0x0131] = "Test Phone"                # Make
    exif[0x013b] = "Photographer Name"         # Artist
    exif[0x0131] = "Test Camera Co"            # Make
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def _make_png_with_metadata() -> bytes:
    """Create a 4x4 PNG with text metadata chunks."""
    from PIL.PngImagePlugin import PngInfo
    img = Image.new("RGB", (4, 4), (0, 255, 0))
    meta = PngInfo()
    meta.add_text("Comment", "Private location data")
    meta.add_text("GPS", "37.7749,-122.4194")
    buf = io.BytesIO()
    img.save(buf, "PNG", pnginfo=meta)
    return buf.getvalue()


def _make_game(client, name="Gallery Game"):
    r = client.post("/api/games/", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _upload_cover(client, game_id, content=_TINY_JPEG, filename="cover.jpg"):
    return client.post(
        f"/api/games/{game_id}/image",
        files={"file": (filename, io.BytesIO(content), "image/jpeg")},
    )


def _upload_gallery(client, game_id, content=_TINY_JPEG, filename="photo.jpg"):
    return client.post(
        f"/api/games/{game_id}/images",
        files={"file": (filename, io.BytesIO(content), "image/jpeg")},
    )


# ---------------------------------------------------------------------------
# Cover image upload
# ---------------------------------------------------------------------------

def test_upload_image_wrong_extension(client):
    gid = _make_game(client)
    r = _upload_cover(client, gid, filename="virus.exe")
    assert r.status_code == 400


def test_upload_image_too_large(client):
    gid = _make_game(client)
    big_content = b"\xff\xd8\xff" + b"\x00" * (10 * 1024 * 1024 + 1)
    r = _upload_cover(client, gid, content=big_content)
    assert r.status_code == 413


def test_upload_image_game_not_found(client):
    r = _upload_cover(client, 99999)
    assert r.status_code == 404


def test_delete_image(client):
    gid = _make_game(client)
    _upload_cover(client, gid)
    r = client.delete(f"/api/games/{gid}/image")
    assert r.status_code == 204
    game = client.get(f"/api/games/{gid}").json()
    assert game["image_url"] is None


# ---------------------------------------------------------------------------
# Gallery
# ---------------------------------------------------------------------------

def test_gallery_upload(client):
    gid = _make_game(client)
    r = _upload_gallery(client, gid)
    assert r.status_code == 201
    data = r.json()
    assert data["game_id"] == gid
    assert data["sort_order"] == 0
    # first gallery image becomes primary image_url
    game = client.get(f"/api/games/{gid}").json()
    assert game["image_url"] is not None


def test_gallery_upload_too_large(client):
    gid = _make_game(client)
    big_content = b"\xff\xd8\xff" + b"\x00" * (10 * 1024 * 1024 + 1)
    r = _upload_gallery(client, gid, content=big_content)
    assert r.status_code == 413


def test_gallery_upload_wrong_extension(client):
    gid = _make_game(client)
    r = _upload_gallery(client, gid, filename="bad.bmp")
    assert r.status_code == 400


def test_gallery_upload_game_not_found(client):
    r = _upload_gallery(client, 99999)
    assert r.status_code == 404


def test_gallery_delete_primary_promotes_next(client):
    gid = _make_game(client)
    img1_id = _upload_gallery(client, gid).json()["id"]
    img2_id = _upload_gallery(client, gid, filename="second.jpg").json()["id"]

    # Delete first (primary) image
    r = client.delete(f"/api/games/{gid}/images/{img1_id}")
    assert r.status_code == 204

    # Second image should now be primary (sort_order=0)
    images = client.get(f"/api/games/{gid}/images").json()
    assert len(images) == 1
    assert images[0]["id"] == img2_id
    assert images[0]["sort_order"] == 0

    game = client.get(f"/api/games/{gid}").json()
    assert f"/images/{img2_id}/file" in game["image_url"]


def test_gallery_reorder(client):
    gid = _make_game(client)
    id1 = _upload_gallery(client, gid).json()["id"]
    id2 = _upload_gallery(client, gid, filename="b.jpg").json()["id"]

    r = client.patch(f"/api/games/{gid}/images/reorder", json={"order": [id2, id1]})
    assert r.status_code == 204

    images = client.get(f"/api/games/{gid}/images").json()
    assert images[0]["id"] == id2
    assert images[1]["id"] == id1


def test_gallery_reorder_duplicate_ids(client):
    gid = _make_game(client)
    id1 = _upload_gallery(client, gid).json()["id"]
    id2 = _upload_gallery(client, gid, filename="b.jpg").json()["id"]

    r = client.patch(f"/api/games/{gid}/images/reorder", json={"order": [id1, id1]})
    assert r.status_code == 400


def test_gallery_reorder_wrong_ids(client):
    gid = _make_game(client)
    id1 = _upload_gallery(client, gid).json()["id"]

    r = client.patch(f"/api/games/{gid}/images/reorder", json={"order": [id1, 99999]})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# EXIF / metadata stripping
# ---------------------------------------------------------------------------

def test_strip_image_metadata_helper_strips_jpeg_exif():
    """Unit test: the helper strips EXIF (incl. GPS) from JPEG bytes."""
    from utils import strip_image_metadata
    original = _make_jpeg_with_exif()
    # Sanity: original has EXIF
    img_before = Image.open(io.BytesIO(original))
    exif_before = img_before.getexif()
    assert exif_before, "test image should have EXIF before stripping"
    assert exif_before.get(0x010e) == "Private description"
    # Strip
    stripped = strip_image_metadata(original, ".jpg")
    img_after = Image.open(io.BytesIO(stripped))
    exif_after = img_after.getexif()
    assert not exif_after, "EXIF should be stripped"
    assert exif_after.get(0x010e) is None, "ImageDescription should be gone"
    assert exif_after.get(0x013b) is None, "Artist should be gone"


def test_strip_image_metadata_helper_strips_png_metadata():
    """Unit test: the helper strips text metadata from PNG bytes."""
    from utils import strip_image_metadata
    original = _make_png_with_metadata()
    # Sanity: original has text metadata
    img_before = Image.open(io.BytesIO(original))
    assert img_before.text.get("Comment") == "Private location data"
    # Strip
    stripped = strip_image_metadata(original, ".png")
    img_after = Image.open(io.BytesIO(stripped))
    assert not img_after.text, "PNG text metadata should be stripped"


def test_strip_image_metadata_preserves_gif():
    """Unit test: GIF is passed through unchanged (preserves animation)."""
    from utils import strip_image_metadata
    img = Image.new("RGB", (4, 4), (0, 0, 255))
    buf = io.BytesIO()
    img.save(buf, "GIF")
    original = buf.getvalue()
    stripped = strip_image_metadata(original, ".gif")
    assert stripped == original, "GIF should pass through unchanged"


def test_gallery_upload_strips_exif(client):
    """Integration test: uploaded gallery image has EXIF stripped on disk."""
    gid = _make_game(client)
    jpeg_with_exif = _make_jpeg_with_exif()
    r = _upload_gallery(client, gid, content=jpeg_with_exif, filename="phone.jpg")
    assert r.status_code == 201
    img_id = r.json()["id"]
    # Fetch the stored image back
    r = client.get(f"/api/games/{gid}/images/{img_id}/file")
    assert r.status_code == 200
    stored = Image.open(io.BytesIO(r.content))
    assert not stored.getexif(), "stored gallery image should have no EXIF"


def test_gallery_file_has_cache_control_header(client):
    """Gallery image file responses should be cacheable (Cache-Control header)."""
    gid = _make_game(client)
    r = _upload_gallery(client, gid, content=_TINY_JPEG, filename="photo.jpg")
    img_id = r.json()["id"]
    r = client.get(f"/api/games/{gid}/images/{img_id}/file")
    assert r.status_code == 200
    cc = r.headers.get("Cache-Control", "")
    assert "max-age=" in cc, f"expected Cache-Control with max-age, got {cc!r}"


def test_cover_upload_strips_exif(client):
    """Integration test: uploaded cover image has EXIF stripped on disk."""
    gid = _make_game(client)
    jpeg_with_exif = _make_jpeg_with_exif()
    r = _upload_cover(client, gid, content=jpeg_with_exif, filename="cover.jpg")
    assert r.status_code == 204
    # Fetch the stored image back
    r = client.get(f"/api/games/{gid}/image")
    assert r.status_code == 200
    stored = Image.open(io.BytesIO(r.content))
    assert not stored.getexif(), "stored cover image should have no EXIF"


def test_avatar_upload_strips_exif(client):
    """Integration test: uploaded avatar has EXIF stripped on disk."""
    from tests.test_players import _make_player
    pid = _make_player(client, "PhotoFace")
    jpeg_with_exif = _make_jpeg_with_exif()
    r = client.post(
        f"/api/players/{pid}/avatar",
        files={"file": ("avatar.jpg", io.BytesIO(jpeg_with_exif), "image/jpeg")},
    )
    assert r.status_code == 200
    # Fetch the stored avatar back
    r = client.get(f"/api/players/{pid}/avatar")
    assert r.status_code == 200
    stored = Image.open(io.BytesIO(r.content))
    assert not stored.getexif(), "stored avatar should have no EXIF"


# ---------------------------------------------------------------------------
# Decompression-bomb ceiling (S-M3)
# ---------------------------------------------------------------------------

def test_pillow_max_image_pixels_is_capped():
    """Pillow's MAX_IMAGE_PIXELS must be set below the default to mitigate DoS."""
    import utils  # ensures the module-level setting is applied
    from PIL import Image
    assert Image.MAX_IMAGE_PIXELS is not None
    assert Image.MAX_IMAGE_PIXELS < 89_478_485  # Pillow's default
