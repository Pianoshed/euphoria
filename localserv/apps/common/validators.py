import re

from django.core.exceptions import ValidationError

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{3,30}$")

DANGEROUS_EXTENSIONS = {
    ".php", ".exe", ".bat", ".ps1", ".py", ".js", ".sh", ".jar", ".msi",
}

ALLOWED_IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_AVATAR_BYTES = 5 * 1024 * 1024  # 5 MB


def validate_username(value: str) -> None:
    if not USERNAME_RE.match(value or ""):
        raise ValidationError(
            "Usernames must be 3-30 characters: letters, numbers, "
            "underscore, period, or hyphen only."
        )


def validate_upload_extension(filename: str) -> None:
    lower = (filename or "").lower()
    for ext in DANGEROUS_EXTENSIONS:
        if lower.endswith(ext):
            raise ValidationError("This file type is not allowed.")


def validate_image_upload(uploaded_file) -> None:
    """Checks declared content-type and size. Callers should still
    verify the actual file signature (e.g. via Pillow.Image.verify())
    before persisting -- declared content-type can be spoofed."""
    if uploaded_file.size > MAX_AVATAR_BYTES:
        raise ValidationError("Image must be smaller than 5MB.")
    content_type = getattr(uploaded_file, "content_type", None)
    if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ValidationError("Unsupported image type.")
    validate_upload_extension(getattr(uploaded_file, "name", ""))
