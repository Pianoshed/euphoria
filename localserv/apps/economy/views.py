from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.wallet import payment_services
from apps.wallet.models import WithdrawalRequest

from . import services
from .models import GiftTransaction, PlannerEarning, TransactionOrder
from .serializers import PromotionalCreditGrantResponseSerializer
from .serializers import EarningSerializer, EarningWithdrawalSerializer, GiftCreateSerializer, GiftSerializer, OrderSerializer


class PromotionalBalanceView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from apps.wallet.services import promotional_balance
        promo = promotional_balance(request.user)
        from apps.wallet.models import Wallet
        wallet = Wallet.objects.get(user=request.user)
        return Response({
            "paid_balance": str(wallet.balance),
            "promotional_balance": str(promo),
            "total_usable": str(wallet.balance + promo),
            "promotional_withdrawable": False,
        })


class PromotionalCreditListView(APIView):
    """Read-only: the caller's own live promotional credits (name/source, code/reference, what is left, expiry).
    Lets the wallet page show where platform credits came from. Cannot create or change anything."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.db.models import Q
        from django.utils import timezone
        from apps.wallet.models import PromotionalCredit
        qs = (PromotionalCredit.objects.filter(user=request.user, remaining_amount__gt=0)
              .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
              .select_related("plan", "category").order_by("expires_at", "created_at")[:50])
        return Response([{
            "id": str(c.id), "source": c.source, "code": (c.metadata or {}).get("promo_code"),
            "original_amount": str(c.original_amount), "remaining_amount": str(c.remaining_amount),
            "expires_at": c.expires_at, "plan_title": c.plan.title if c.plan_id else None,
            "category_name": c.category.name if c.category_id else None,
            "withdrawable": False,
        } for c in qs])


class PromotionalCreditGrantView(APIView):
    """Staff-only grant endpoint; clients cannot mint promotional value."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        from apps.services.models import Service, ServiceCategory
        from apps.wallet.services import grant_promotional_credit
        from .serializers import PromotionalCreditSerializer
        serializer = PromotionalCreditSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        user = User.objects.filter(id=data["user_id"], is_active=True).first()
        if user is None:
            raise NotFound("User not found.")
        plan = Service.objects.filter(id=data.get("plan_id"), is_plan=True).first() if data.get("plan_id") else None
        if data.get("plan_id") and plan is None:
            raise NotFound("Plan not found.")
        category = ServiceCategory.objects.filter(id=data.get("category_id")).first() if data.get("category_id") else None
        if data.get("category_id") and category is None:
            raise NotFound("Category not found.")
        credit = grant_promotional_credit(
            user, amount=data["amount"], expires_at=data.get("expires_at"), plan=plan, category=category,
            source=data.get("source", "PROMOTION"), reference=data.get("reference") or None,
            metadata={"granted_by": str(request.user.id)},
        )
        return Response(PromotionalCreditGrantResponseSerializer({
            "id": credit.id, "user_id": credit.user_id, "amount": credit.original_amount,
            "remaining_amount": credit.remaining_amount, "expires_at": credit.expires_at,
            "source": credit.source, "reference": credit.reference, "created_at": credit.created_at,
        }).data, status=status.HTTP_201_CREATED)


class OrderListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = TransactionOrder.objects.filter(buyer=request.user).select_related("plan", "booking").order_by("-created_at")
        return Response(OrderSerializer(qs[:100], many=True).data)


class EarningListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = PlannerEarning.objects.filter(planner=request.user).order_by("-created_at")
        return Response(EarningSerializer(qs[:100], many=True).data)


class EarningSummaryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({k: str(v) for k, v in services.earnings_summary(request.user).items()})


class AvailableEarningView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(EarningSerializer(services.available_earnings(request.user), many=True).data)


class EarningWithdrawView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def post(self, request):
        serializer = EarningWithdrawalSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        existing = WithdrawalRequest.objects.filter(idempotency_key=data["idempotency_key"], user=request.user).first()
        if existing is not None:
            return Response({"withdrawal_id": str(existing.id), "status": existing.status})
        # Reserve earnings first. Existing payout provider is then used through the existing
        # WithdrawalRequest machinery with source=EARNINGS. If provider dispatch fails, the
        # withdrawal path reverses the reservation through the same idempotent key.
        # Check the password BEFORE reserving anything, so a wrong guess can never briefly lock earnings.
        payment_services.verify_password(request.user, data["current_password"], data.get("otp_code", ""))
        allocations = services.withdraw_earnings(request.user, amount=data["amount"], idempotency_key=data["idempotency_key"])
        try:
            withdrawal = payment_services.request_withdrawal(
                request.user,
                amount=data["amount"],
                payout_account_id=data["payout_account_id"],
                current_password=data["current_password"],
                otp_code=data.get("otp_code", ""),
                idempotency_key=data["idempotency_key"],
                source="EARNINGS",
                earning_allocations=[{"earning_id": str(eid), "amount": str(take)} for eid, take in allocations],
            )
        except Exception:
            # Put the reserved earnings back ONLY if no WithdrawalRequest exists for this key. Once one
            # exists, the withdrawal machinery owns the reservation (it releases it on refund); releasing
            # it here as well would free money reserved by a different in-flight payout.
            if not WithdrawalRequest.objects.filter(idempotency_key=data["idempotency_key"]).exists():
                services.restore_earning_allocations(allocations, data["idempotency_key"])
            raise
        return Response({"withdrawal_id": str(withdrawal.id), "status": withdrawal.status}, status=status.HTTP_201_CREATED)


class GiftListCreateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def get(self, request):
        qs = GiftTransaction.objects.filter(sender=request.user) | GiftTransaction.objects.filter(recipient=request.user)
        return Response(GiftSerializer(qs.order_by("-created_at")[:100], many=True).data)

    def post(self, request):
        serializer = GiftCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        recipient = User.objects.filter(id=data.pop("recipient_id"), is_active=True).first()
        if recipient is None:
            raise NotFound("Recipient not found.")
        gift = services.create_gift(request.user, recipient=recipient, **data)
        return Response(GiftSerializer(gift).data, status=status.HTTP_201_CREATED)


class GiftActionView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def post(self, request, gift_id, action):
        try:
            gift = services.accept_gift(request.user, gift_id) if action == "accept" else services.decline_gift(request.user, gift_id)
        except GiftTransaction.DoesNotExist as exc:
            raise NotFound("Gift not found.") from exc
        return Response(GiftSerializer(gift).data)
