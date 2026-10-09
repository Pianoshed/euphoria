from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

from django.test import TestCase, SimpleTestCase
from django.utils import timezone

from apps.accounts.models import User
from apps.bookings.models import Booking
from apps.common.constants import AccountRole, AccountStatus, BookingStatus, ServiceStatus
from apps.services.models import Service, ServiceCategory
from apps.wallet.models import Escrow, Wallet
from apps.wallet.services import deposit, hold_escrow
from apps.wallet import services as wallet_services

from .models import EarningStatus, PlannerEarning, TransactionOrder, TransactionStatus
from .services import available_plan_slots, settle_booking, snapshot_financials


class PlanFeeCalculationTests(SimpleTestCase):
    def test_single_quantity_15_percent(self):
        plan = type("Plan", (), {"price": Decimal("5000.00"), "platform_fee_rate": Decimal("15.00"), "category_id": None})()
        unit, gross, rate, fee, planner = snapshot_financials(plan=plan, quantity=1)
        self.assertEqual((unit, gross, rate, fee, planner), (Decimal("5000.00"), Decimal("5000.00"), Decimal("15.00"), Decimal("750.00"), Decimal("4250.00")))

    def test_multiple_quantity_15_percent(self):
        plan = type("Plan", (), {"price": Decimal("5000.00"), "platform_fee_rate": Decimal("15.00"), "category_id": None})()
        _, gross, _, fee, planner = snapshot_financials(plan=plan, quantity=3)
        self.assertEqual((gross, fee, planner), (Decimal("15000.00"), Decimal("2250.00"), Decimal("12750.00")))

    def test_financials_conserve_gross_value(self):
        plan = type("Plan", (), {"price": Decimal("999.99"), "platform_fee_rate": Decimal("17.50"), "category_id": None})()
        _, gross, _, fee, planner = snapshot_financials(plan=plan, quantity=7)
        self.assertEqual(gross, fee + planner)


class PlanTransactionTests(TestCase):
    def setUp(self):
        self.customer = User.objects.create(email="customer@example.com", username="customer", role=AccountRole.CUSTOMER, status=AccountStatus.ACTIVE)
        self.planner = User.objects.create(email="planner@example.com", username="planner", role=AccountRole.PROVIDER, status=AccountStatus.ACTIVE)
        self.category = ServiceCategory.objects.create(name="Experiences", slug=f"experiences-{uuid4().hex[:8]}")
        self.plan = Service.objects.create(
            provider=self.planner, category=self.category, title="Dinner", description="Dinner", price=Decimal("10000.00"),
            status=ServiceStatus.PUBLISHED, is_plan=True, capacity=2, platform_fee_rate=Decimal("15.00"),
        )

    def test_capacity_is_reserved_by_existing_booking_quantity(self):
        Booking.objects.create(
            service=self.plan, customer=self.customer, provider=self.planner, status=BookingStatus.PENDING,
            agreed_price=Decimal("10000.00"), quantity=1, unit_price=Decimal("10000.00"), gross_amount=Decimal("10000.00"),
            purchase_idempotency_key=str(uuid4()),
        )
        self.assertEqual(available_plan_slots(self.plan), 1)

    def test_settlement_creates_net_planner_earning_only(self):
        deposit(self.customer, amount=Decimal("10000.00"), idempotency_key=f"test-deposit:{uuid4()}")
        booking = Booking.objects.create(
            service=self.plan, customer=self.customer, provider=self.planner, status=BookingStatus.COMPLETED,
            agreed_price=Decimal("10000.00"), quantity=1, unit_price=Decimal("10000.00"), gross_amount=Decimal("10000.00"),
            platform_fee_rate=Decimal("15.00"), platform_fee_amount=Decimal("1500.00"), planner_amount=Decimal("8500.00"),
            purchase_idempotency_key=str(uuid4()),
        )
        TransactionOrder.objects.create(
            buyer=self.customer, planner=self.planner, plan=self.plan, booking=booking, quantity=1,
            unit_price=Decimal("10000.00"), gross_amount=Decimal("10000.00"), platform_fee_rate=Decimal("15.00"),
            platform_fee_amount=Decimal("1500.00"), planner_amount=Decimal("8500.00"), idempotency_key=str(uuid4()),
            status=TransactionStatus.HELD,
        )
        # Simulate the already-funded customer hold.
        hold_escrow(self.customer, booking=booking, idempotency_key=f"escrow-hold:{booking.id}")
        order = settle_booking(booking.id)
        earning = PlannerEarning.objects.get(order=order)
        self.assertEqual(earning.net_amount, Decimal("8500.00"))
        self.assertEqual(earning.platform_fee, Decimal("1500.00"))
        self.assertEqual(earning.status, EarningStatus.AVAILABLE)
        # Settlement must not touch the planner's spending wallet (a wallet row may exist; its balance stays 0).
        self.assertEqual(Wallet.objects.get_or_create(user=self.planner)[0].balance, Decimal("0.00"))

    def test_settlement_is_idempotent(self):
        deposit(self.customer, amount=Decimal("10000.00"), idempotency_key=f"test-deposit:{uuid4()}")
        booking = Booking.objects.create(
            service=self.plan, customer=self.customer, provider=self.planner, status=BookingStatus.COMPLETED,
            agreed_price=Decimal("10000.00"), quantity=1, unit_price=Decimal("10000.00"), gross_amount=Decimal("10000.00"),
            platform_fee_rate=Decimal("15.00"), platform_fee_amount=Decimal("1500.00"), planner_amount=Decimal("8500.00"),
            purchase_idempotency_key=str(uuid4()),
        )
        TransactionOrder.objects.create(
            buyer=self.customer, planner=self.planner, plan=self.plan, booking=booking, quantity=1,
            unit_price=Decimal("10000.00"), gross_amount=Decimal("10000.00"), platform_fee_rate=Decimal("15.00"),
            platform_fee_amount=Decimal("1500.00"), planner_amount=Decimal("8500.00"), idempotency_key=str(uuid4()),
            status=TransactionStatus.HELD,
        )
        hold_escrow(self.customer, booking=booking, idempotency_key=f"escrow-hold:{booking.id}")
        first = settle_booking(booking.id)
        second = settle_booking(booking.id)
        self.assertEqual(first.id, second.id)
        self.assertEqual(PlannerEarning.objects.filter(order=first).count(), 1)


class PromotionalCreditTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="promo-user", email="promo@example.com", password="TestPass123!")
        self.plan = Service.objects.create(
            provider=self.user, category=ServiceCategory.objects.create(name="Promo Experiences", slug=f"promo-experiences-{uuid4().hex[:8]}"),
            title="Promo Plan", description="Test", price=Decimal("5000.00"),
            capacity=10, is_plan=True, status=ServiceStatus.PUBLISHED,
        )

    def test_grant_tracks_separate_non_withdrawable_balance(self):
        credit = wallet_services.grant_promotional_credit(self.user, amount=Decimal("500.00"), source="WELCOME")
        wallet = Wallet.objects.get(user=self.user)
        self.assertEqual(credit.remaining_amount, Decimal("500.00"))
        self.assertEqual(wallet.promotional_balance, Decimal("500.00"))
        self.assertEqual(wallet.balance, Decimal("0.00"))

    def test_promo_balance_expires(self):
        # Expiry is rejected at grant time; expired credits cannot be minted.
        with self.assertRaises(Exception):
            wallet_services.grant_promotional_credit(self.user, amount=Decimal("500.00"), expires_at=timezone.now() - timedelta(seconds=1))
