"""
Chat message attachment processing: images, and short voice notes.

Same reasoning as apps.accounts.media_utils.process_avatar_upload:
declared content-type and filename can be spoofed, so we verify the
actual file signature with Pillow and re-encode server-side (strips
EXIF -- including GPS coordinates of where a photo was taken, which
matters more here than for avatars, since a chat photo is often taken
on-site at a customer's home) rather than storing the uploaded bytes
verbatim.
"""
import io

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

from apps.common.validators import validate_image_upload

MAX_DIMENSION = 2048


def process_message_attachment(uploaded_file) -> ContentFile:
    try:
        validate_image_upload(uploaded_file)
    except DjangoValidationError as exc:
        raise ValidationError({"attachment": list(exc.messages)}) from exc

    uploaded_file.seek(0)
    try:
        img = Image.open(uploaded_file)
        img.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationError({"attachment": ["This file is not a valid image."]}) from exc

    uploaded_file.seek(0)
    img = Image.open(uploaded_file)
    img = img.convert("RGB")
    img.thumbnail((MAX_DIMENSION, MAX_DIMENSION))

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=85)
    buffer.seek(0)
    return ContentFile(buffer.read())


# ---------------------------------------------------------------------------
# Voice notes
# ---------------------------------------------------------------------------
MAX_VOICE_BYTES = 5 * 1024 * 1024   # ~2 min of browser-recorded opus is well under 2 MB
MAX_VOICE_SECONDS = 120
MIN_VOICE_BYTES = 200


def _sniff_audio(head: bytes):
    """Returns (extension, mime) from the file's real signature, or None.
    Same posture as the image path: the declared content-type and filename
    can be spoofed, so only the bytes decide."""
    if head[:4] == b"\x1a\x45\xdf\xa3":                       # EBML: webm (Chrome/Firefox/Edge)
        return "webm", "audio/webm"
    if head[:4] == b"OggS":                                       # Firefox ogg/opus
        return "ogg", "audio/ogg"
    if head[4:8] == b"ftyp":                                      # mp4/m4a (Safari/iOS)
        return "m4a", "audio/mp4"
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "mp3", "audio/mpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav", "audio/wav"
    return None


def process_voice_upload(uploaded_file):
    """Validates a voice note and returns (ContentFile, extension).

    Audio can't be cheaply re-encoded server-side the way images are, so this checks
    size, then the real signature, and stores the bytes under a SERVER-chosen
    extension. The file is only ever served back as that audio type."""
    size = getattr(uploaded_file, "size", 0) or 0
    if size < MIN_VOICE_BYTES:
        raise ValidationError({"attachment": ["This voice message is empty."]})
    if size > MAX_VOICE_BYTES:
        raise ValidationError({"attachment": ["This voice message is too large (max 5 MB)."]})

    uploaded_file.seek(0)
    head = uploaded_file.read(16)
    sniffed = _sniff_audio(head)
    if sniffed is None:
        raise ValidationError({"attachment": ["This file is not a supported audio recording."]})

    uploaded_file.seek(0)
    return ContentFile(uploaded_file.read()), sniffed[0]


def clamp_voice_duration(value):
    """Duration is reported by the recorder, so it's only a display hint: clamp, never trust."""
    try:
        seconds = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return max(1, min(seconds, MAX_VOICE_SECONDS + 5))
