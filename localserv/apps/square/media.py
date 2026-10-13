"""Status media. Same posture as apps.chat.media_utils: the bytes decide, not the declared
type or filename. Images are re-encoded (EXIF/GPS stripped) at a smaller size than chat photos.
Video can't be cheaply re-encoded here, so the BROWSER trims to 15s and re-encodes at a low
bitrate (see shrinkMedia.js); the server enforces size, real file signature and the length cap."""
import io

from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

from apps.common.validators import validate_image_upload

MAX_IMAGE_SIDE = 1080
MAX_VIDEO_BYTES = 6 * 1024 * 1024
MAX_VIDEO_SECONDS = 15

# Slideshow limits. The browser already shrinks photos before upload (shrinkMedia.js); these only bound what the
# server accepts. Everything is re-encoded server-side as small WebP, so ~7 slides cost roughly 0.7-1.2 MB in the
# bucket in total (a 15s status video is up to 6 MB).
MIN_SLIDE_SECONDS, MAX_SLIDE_SECONDS, DEFAULT_SLIDE_SECONDS = 2, 6, 3
# Same 15 s ceiling as videos: photos x seconds-per-photo may never exceed it (7 photos x 2 s = 14 s is the most that fits).
MAX_SHOW_SECONDS = MAX_VIDEO_SECONDS
MIN_SLIDES = 2
MAX_SLIDES = MAX_SHOW_SECONDS // MIN_SLIDE_SECONDS
MAX_SLIDES_UPLOAD_BYTES = 25 * 1024 * 1024
COVER_SIDE = 360  # the cover is a SQUARE this size, cropped to fit the round story ring exactly

# How a slideshow is *displayed*. Only these names are stored; the app draws them (see Square.jsx / square.css).
#   template = the motion between photos, canvas = the stage the photo sits on.
TEMPLATES = ("fade", "drift", "slide", "pop",       # crossfade, slow zoom (Ken Burns), slide, pop
             "cinema", "burst", "spin", "flip", "curtain", "flash", "swing", "zoomout")  # dramatic in/out; names <= 12 chars (model max_length)
CANVASES = ("blur", "fill", "frame", "night")    # blurred backdrop, full-bleed, polaroid card, dark
DEFAULT_TEMPLATE, DEFAULT_CANVAS = "fade", "blur"


def process_image(uploaded_file) -> ContentFile:
    try:
        validate_image_upload(uploaded_file)
    except DjangoValidationError as exc:
        raise ValidationError({"file": list(exc.messages)}) from exc
    uploaded_file.seek(0)
    try:
        Image.open(uploaded_file).verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValidationError({"file": ["This file is not a valid image."]}) from exc
    uploaded_file.seek(0)
    img = Image.open(uploaded_file)
    # Shrink BEFORE converting: thumbnail() lets Pillow decode JPEGs at reduced size, so a huge photo
    # is never held in memory at full resolution (convert() first would decode every pixel).
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
    img = ImageOps.exif_transpose(img).convert("RGB")  # upright, since the EXIF orientation is dropped on save
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=72, optimize=True)
    return ContentFile(buf.getvalue())


def _sniff_video(head: bytes):
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if head[4:8] == b"ftyp":
        return "mp4"
    return None


def process_video(uploaded_file, reported_seconds):
    """Returns (ContentFile, extension, whole seconds)."""
    size = getattr(uploaded_file, "size", 0) or 0
    if size < 1000:
        raise ValidationError({"file": ["This video is empty."]})
    if size > MAX_VIDEO_BYTES:
        raise ValidationError({"file": ["This video is too large (max 6 MB). Keep clips to 15 seconds."]})
    uploaded_file.seek(0)
    ext = _sniff_video(uploaded_file.read(16))
    if ext is None:
        raise ValidationError({"file": ["This file is not a supported video."]})
    try:
        seconds = int(round(float(reported_seconds)))
    except (TypeError, ValueError):
        seconds = None
    if seconds is None or seconds < 1 or seconds > MAX_VIDEO_SECONDS + 1:
        raise ValidationError({"file": [f"Videos can be at most {MAX_VIDEO_SECONDS} seconds."]})
    uploaded_file.seek(0)
    return ContentFile(uploaded_file.read()), ext, min(seconds, MAX_VIDEO_SECONDS)


# ---------------------------------------------------------------------------------------------- slideshows

def _open_validated(uploaded_file) -> Image.Image:
    """Same checks as process_image (declared type + size, then Pillow must really decode it)."""
    try:
        validate_image_upload(uploaded_file)
    except DjangoValidationError as exc:
        raise ValidationError({"file": list(exc.messages)}) from exc
    uploaded_file.seek(0)
    try:
        Image.open(uploaded_file).verify()
        uploaded_file.seek(0)
        return Image.open(uploaded_file)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValidationError({"file": ["This file is not a valid image."]}) from exc


def _to_rgb(img: Image.Image) -> Image.Image:
    """Flatten transparency onto white (a bare convert("RGB") turns transparent PNG areas black)."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        base = Image.new("RGB", rgba.size, (255, 255, 255))
        base.paste(rgba, mask=rgba.getchannel("A"))
        return base
    return img.convert("RGB")


def _webp(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=4)  # method 4: good size/CPU balance on a small instance
    return buf.getvalue()


def process_slides(files):
    """Validate + compress the pictures of a slideshow.

    Returns (slides, cover): slides = [(ContentFile, width, height), ...] in upload order, cover = ContentFile.
    Each picture is shrunk before decoding fully (Pillow's JPEG draft mode), rotated upright from its EXIF
    orientation (the EXIF itself, incl. GPS, is dropped on re-encode) and saved as WebP. Only the small encoded
    bytes are kept between pictures, so memory stays flat however many slides there are."""
    files = list(files)
    if not (MIN_SLIDES <= len(files) <= MAX_SLIDES):
        raise ValidationError({"slides": [f"Choose between {MIN_SLIDES} and {MAX_SLIDES} photos."]})
    if sum(getattr(f, "size", 0) or 0 for f in files) > MAX_SLIDES_UPLOAD_BYTES:
        raise ValidationError({"slides": ["These photos are too big together. Let the app shrink them first."]})
    side = getattr(settings, "STATUS_SLIDE_MAX_SIDE", 1280)
    quality = getattr(settings, "STATUS_SLIDE_QUALITY", 70)
    out, cover = [], None
    for i, f in enumerate(files):
        img = _open_validated(f)
        img.thumbnail((side, side))
        img = _to_rgb(ImageOps.exif_transpose(img))
        out.append((ContentFile(_webp(img, quality)), img.width, img.height))
        if i == 0:
            # Square, centred a little above the middle (faces sit high), so the round ring never has to crop again.
            thumb = ImageOps.fit(img, (COVER_SIDE, COVER_SIDE), method=Image.LANCZOS, centering=(0.5, 0.4))
            cover = ContentFile(_webp(thumb, 60))
    return out, cover


def parse_slide_seconds(raw, count=None) -> int:
    """Seconds each photo shows. When `count` (number of photos) is known, the whole show must fit in 15 s."""
    if raw in (None, ""):
        n = DEFAULT_SLIDE_SECONDS
    else:
        try:
            n = int(float(raw))
        except (TypeError, ValueError):
            raise ValidationError({"slide_seconds": ["Pick how many seconds each photo shows."]})
    if not (MIN_SLIDE_SECONDS <= n <= MAX_SLIDE_SECONDS):
        raise ValidationError({"slide_seconds": [f"Each photo can show for {MIN_SLIDE_SECONDS}-{MAX_SLIDE_SECONDS} seconds."]})
    if count and n * count > MAX_SHOW_SECONDS:
        if raw in (None, ""):  # nothing was asked for: shorten the default instead of failing
            return max(MIN_SLIDE_SECONDS, MAX_SHOW_SECONDS // count)
        raise ValidationError({"slide_seconds": [f"A slideshow can run at most {MAX_SHOW_SECONDS} seconds in total."]})
    return n


def parse_choice(raw, allowed, default, field):
    """One of `allowed` (blank -> default). Anything else is a 400, so only known looks are ever stored."""
    if raw in (None, ""):
        return default
    raw = str(raw).strip().lower()
    if raw not in allowed:
        raise ValidationError({field: [f"Pick one of: {', '.join(allowed)}."]})
    return raw
