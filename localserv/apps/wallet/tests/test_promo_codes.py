from decimal import Decimal

import pytest
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.wallet import services
from apps.wallet.models import PromoCode, PromotionalCredit

pytestmark = pytest.mark.django_db


def make_user(n, **kw):
    user = User.objects.create_user(email=f"u{n}@example.com", username=f"user{n}", password="a-strong-password-1", **kw)
    user.mark_email_verified()
    return user


def make_staff():
    u = User.objects.create_user(email="staff@example.com", username="staffer", password="a-strong-password-1", role="ADMIN", is_staff=True)
    u.mark_email_verified()
    return u


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()


def test_staff_creates_code_and_autogenerates_when_blank():
    promo = services.create_promo_code(make_staff(), name="Welcome", amount=Decimal("1500"))
    assert promo.code.startswith("EUPH-") and promo.amount == Decimal("1500.00")


def test_non_staff_cannot_create_code():
    with pytest.raises(AccountNotEligibleError):
        services.create_promo_code(make_user(1), name="x", amount=Decimal("100"))


def test_redeem_grants_promotional_credit_only_never_paid_balance():
    promo = services.create_promo_code(make_staff(), name="Welcome", amount=Decimal("2000"), code="welcome 2k", credit_valid_days=30)
    user = make_user(1)
    credit = services.redeem_promo_code(user, " welcome2k ")  # case + spaces forgiven
    assert credit.original_amount == Decimal("2000.00") and credit.expires_at is not None
    assert services.promotional_balance(user) == Decimal("2000.00")
    assert services.get_balance(user) == Decimal("0.00")        # never withdrawable cash
    promo.refresh_from_db()
    assert promo.redeemed_count == 1


def test_one_redemption_per_person():
    services.create_promo_code(make_staff(), name="W", amount=Decimal("500"), code="ONCE")
    user = make_user(1)
    services.redeem_promo_code(user, "ONCE")
    with pytest.raises(DomainError):
        services.redeem_promo_code(user, "ONCE")
    assert PromotionalCredit.objects.filter(user=user).count() == 1


def test_cap_is_enforced():
    services.create_promo_code(make_staff(), name="W", amount=Decimal("500"), code="CAP1", max_redemptions=1)
    services.redeem_promo_code(make_user(1), "CAP1")
    with pytest.raises(DomainError, match="fully claimed"):
        services.redeem_promo_code(make_user(2), "CAP1")


def test_inactive_expired_and_unknown_codes_look_the_same():
    promo = services.create_promo_code(make_staff(), name="W", amount=Decimal("500"), code="OFF")
    promo.is_active = False
    promo.save()
    user = make_user(1)
    for code in ("OFF", "NOPE"):
        with pytest.raises(DomainError, match="isn't valid"):
            services.redeem_promo_code(user, code)


def test_guessing_codes_gets_locked_out():
    user = make_user(1)
    for _ in range(services.PROMO_MAX_FAILURES):
        with pytest.raises(DomainError):
            services.redeem_promo_code(user, "WRONG")
    with pytest.raises(DomainError, match="Too many"):
        services.redeem_promo_code(user, "WRONG")


def test_unverified_user_cannot_redeem():
    services.create_promo_code(make_staff(), name="W", amount=Decimal("500"), code="VERIFY")
    user = User.objects.create_user(email="n@example.com", username="newbie", password="a-strong-password-1")
    with pytest.raises(AccountNotEligibleError):
        services.redeem_promo_code(user, "VERIFY")


def test_redeem_endpoint_and_staff_only_management(client):
    staff = make_staff()
    services.create_promo_code(staff, name="Welcome", amount=Decimal("1000"), code="HELLO")
    user = make_user(1)
    client.post(reverse("accounts:login"), {"email": user.email, "password": "a-strong-password-1"}, content_type="application/json")
    resp = client.post(reverse("wallet:promo-redeem"), {"code": "hello"}, content_type="application/json")
    assert resp.status_code == 201 and resp.json()["promotional_balance"] == "1000.00"
    assert client.get(reverse("wallet:promo-codes")).status_code == 403  # regular users can't list codes
    assert client.post(reverse("wallet:promo-codes"), {"name": "x", "amount": "100"}, content_type="application/json").status_code == 403
