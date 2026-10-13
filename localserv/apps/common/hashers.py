from django.contrib.auth.hashers import Argon2PasswordHasher


class LightArgon2PasswordHasher(Argon2PasswordHasher):
    """Argon2id with ~19 MiB of memory per hash (OWASP's minimum recommendation) instead of Django's ~100 MiB.

    Existing password hashes keep verifying (Argon2 reads its parameters from the stored hash) and are
    re-hashed with these settings automatically the next time that user logs in."""

    time_cost = 2
    memory_cost = 19456  # KiB
    parallelism = 1
