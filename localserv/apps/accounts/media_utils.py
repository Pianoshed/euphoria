"""
Avatar upload processing.

Declared content-type and filename can both be spoofed by the
client, so:
  1. We verify the ACTUAL file signature with Pillow (Image.verify()
     raises on anything that isn't a genuine, well-formed image).
  2. We re-encode the image ourselves rather than storing the
     uploaded bytes verbatim -- this strips EXIF metadata (which can
     contain GPS coordinates of where the photo was taken) and any
     trailing/embedded non-image payload a crafted file might carry.
  3. The stored filename is always server-generated (see
     apps.accounts.models.avatar_upload_path) -- the client's
     filename is never used for anything but the original validation
     pass in apps.common.validators.
"""
import io

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

from apps.common.validators import validate_image_upload

MAX_DIMENSION = 2048


def process_avatar_upload(uploaded_file) -> ContentFile:
    try:
        validate_image_upload(uploaded_file)
    except DjangoValidationError as exc:
        raise ValidationError({"avatar": list(exc.messages)}) from exc

    uploaded_file.seek(0)
    try:
        img = Image.open(uploaded_file)
        img.verify()  # raises if the file isn't a genuine image
    except (UnidentifiedImageError, OSError) as exc:
        raise ValidationError({"avatar": ["This file is not a valid image."]}) from exc

    # Re-open: verify() leaves the file object unusable for further ops.
    uploaded_file.seek(0)
    img = Image.open(uploaded_file)
    img = img.convert("RGB")  # drops alpha/EXIF orientation edge cases too
    img.thumbnail((MAX_DIMENSION, MAX_DIMENSION))

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=85)  # no exif= kwarg -> metadata dropped
    buffer.seek(0)
    return ContentFile(buffer.read())
