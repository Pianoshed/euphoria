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
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

from apps.common.validators import validate_image_upload

AVATAR_SIZE = 512  # square: avatars are shown in circles, so store them already centred and square


def process_avatar_upload(uploaded_file) -> ContentFile:
    try:
        validate_image_upload(uploaded_file)
    except DjangoValidationError as exc:
        raise ValidationError({"avatar": list(exc.messages)}) from exc

    uploaded_file.seek(0)
    try:
        img = Image.open(uploaded_file)
        img.verify()  # raises if the file isn't a genuine image
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValidationError({"avatar": ["This file is not a valid image."]}) from exc

    # Re-open: verify() leaves the file object unusable for further ops.
    uploaded_file.seek(0)
    img = Image.open(uploaded_file)
    # Phones store portrait shots sideways plus an EXIF "rotate me" flag. We strip EXIF below,
    # so apply the rotation first or the saved photo comes out sideways / upside down.
    # Shrink first (the EXIF orientation tag survives thumbnail()), so a huge photo is never fully decoded.
    img.thumbnail((AVATAR_SIZE * 2, AVATAR_SIZE * 2))
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        # Flatten transparency onto white (a plain convert("RGB") turns it black).
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.getchannel("A"))
        img = background
    else:
        img = img.convert("RGB")
    # Centre-crop to a square so a wide or tall photo fills the circle instead of being squashed or
    # showing only a slice; never upscale a small photo beyond its own shortest side.
    side = min(AVATAR_SIZE, *img.size)
    img = ImageOps.fit(img, (side, side), method=Image.LANCZOS, centering=(0.5, 0.4))

    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=85)  # no exif= kwarg -> metadata dropped
    buffer.seek(0)
    return ContentFile(buffer.read())
