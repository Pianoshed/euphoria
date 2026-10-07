"""Status media. Same posture as apps.chat.media_utils: the bytes decide, not the declared
type or filename. Images are re-encoded (EXIF/GPS stripped) at a smaller size than chat photos.
Video can't be cheaply re-encoded here, so the BROWSER trims to 15s and re-encodes at a low
bitrate (see shrinkMedia.js); the server enforces size, real file signature and the length cap."""
import io

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

from apps.common.validators import validate_image_upload

MAX_IMAGE_SIDE = 1080
MAX_VIDEO_BYTES = 6 * 1024 * 1024
MAX_VIDEO_SECONDS = 15


def process_image(uploaded_file) -> ContentFile:
    try:
        validate_image_upload(uploaded_file)
    except DjangoValidationError as exc:
        raise ValidationError({"file": list(exc.messages)}) from exc
    uploaded_file.seek(0)
    try:
        Image.open(uploaded_file).verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationError({"file": ["This file is not a valid image."]}) from exc
    uploaded_file.seek(0)
    img = Image.open(uploaded_file).convert("RGB")
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
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
