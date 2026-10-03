"""
Chat message attachment processing (images only, this pass).

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
