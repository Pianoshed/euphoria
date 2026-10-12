"""The payment provider is a network call: it must never run while a DB transaction (and its
Postgres connection / row lock) is held open, and failure/replay behaviour must be unchanged."""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import connection
from django.utils import timezone

from apps.accounts.models import User
from apps.common.exceptions import DomainError
from apps.wallet import payment_services, services as wallet_services
from apps.wallet.models import PaymentIntent

pytestmark = pytest.mark.django_db(transaction=True)  # real autocommit, so in_atomic_block is meaningful


def make_user(i=1):
    u = User.objects.create_user(email=f"d{i}@example.com", username=f"d{i}user", password="a-strong-password-1", role="CUSTOMER")
    u.mark_email_verified()
    return u


class FakeProvider:
    name = "fake"

    def __init__(self, *, fail=False, paid=True):
        self.fail, self.paid = fail, paid
        self.in_tx_during_call = []

    def initiate_deposit(self, *, user, amount, idempotency_key):
        self.in_tx_during_call.append(connection.in_atomic_block)
        if self.fail:
            raise DomainError("Could not start the payment. Please try again shortly.")
        return {"provider_reference": f"REF-{idempotency_key}", "client_action": {"checkout_url": "https://pay.example/x"}}

    def verify_webhook_signature(self, *, headers, body):
        return True

    def parse_webhook_event(self, *, body):
        return {"status": "succeeded", "provider_reference": "REF-k1", "amount": Decimal("500.00"), "event_id": "evt-1"}

    def verify_deposit(self, *, transaction_reference):
        self.in_tx_during_call.append(connection.in_atomic_block)
        return {"paid": self.paid, "amount": Decimal("500.00")}


@pytest.fixture
def provider(monkeypatch):
    p = FakeProvider()
    monkeypatch.setattr(payment_services, "get_provider", lambda: p)
    return p


def test_initiate_deposit_calls_provider_outside_a_transaction(provider):
    user = make_user()
    intent = payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    assert provider.in_tx_during_call == [False]
    assert intent.provider_reference == "REF-k1" and intent.checkout_url == "https://pay.example/x"
    assert PaymentIntent.objects.count() == 1


def test_provider_failure_leaves_no_row_and_same_key_can_be_retried(monkeypatch):
    user = make_user()
    bad = FakeProvider(fail=True)
    monkeypatch.setattr(payment_services, "get_provider", lambda: bad)
    with pytest.raises(DomainError):
        payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    assert PaymentIntent.objects.count() == 0  # same all-or-nothing result as the old single transaction
    good = FakeProvider()
    monkeypatch.setattr(payment_services, "get_provider", lambda: good)
    intent = payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    assert intent.provider_reference == "REF-k1"


def test_replay_returns_same_intent_and_calls_provider_once(provider):
    user = make_user()
    a = payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    b = payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    assert a.id == b.id and len(provider.in_tx_during_call) == 1


def test_key_belonging_to_another_user_is_rejected(provider):
    payment_services.initiate_deposit(make_user(1), amount=Decimal("500.00"), idempotency_key="k1")
    with pytest.raises(DomainError):
        payment_services.initiate_deposit(make_user(2), amount=Decimal("500.00"), idempotency_key="k1")


def test_start_still_in_flight_asks_to_retry_instead_of_returning_a_half_made_intent(provider):
    user = make_user()
    PaymentIntent.objects.create(user=user, amount=Decimal("500.00"), provider="fake", status="PENDING", idempotency_key="k1")
    with pytest.raises(DomainError, match="still being set up"):
        payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    assert provider.in_tx_during_call == []


def test_abandoned_start_is_replaced(provider):
    user = make_user()
    old = PaymentIntent.objects.create(user=user, amount=Decimal("500.00"), provider="fake", status="PENDING", idempotency_key="k1")
    PaymentIntent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(minutes=5))
    intent = payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="k1")
    assert intent.provider_reference == "REF-k1" and PaymentIntent.objects.count() == 1


def _pending(user, **kw):
    return PaymentIntent.objects.create(
        user=user, amount=Decimal("500.00"), provider="fake", status="PENDING", idempotency_key="k1",
        provider_reference="REF-k1", **kw)


def test_webhook_confirms_with_provider_outside_a_transaction_then_credits_once(provider):
    user = make_user()
    _pending(user)
    r1 = payment_services.process_deposit_webhook(headers={}, body=b"{}")
    r2 = payment_services.process_deposit_webhook(headers={}, body=b"{}")  # replay
    assert r1.status == "SUCCEEDED" and r2.status == "SUCCEEDED"
    assert provider.in_tx_during_call == [False]  # second delivery is already SUCCEEDED: no second call
    assert wallet_services.get_balance(user) == Decimal("500.00")  # credited exactly once


def test_webhook_not_confirmed_by_provider_credits_nothing(monkeypatch):
    user = make_user()
    _pending(user)
    p = FakeProvider(paid=False)
    monkeypatch.setattr(payment_services, "get_provider", lambda: p)
    with pytest.raises(DomainError, match="could not be confirmed"):
        payment_services.process_deposit_webhook(headers={}, body=b"{}")
    assert PaymentIntent.objects.get().status == "PENDING"
    assert wallet_services.get_balance(user) == Decimal("0.00")
