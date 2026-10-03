from django.db import transaction
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.accounts.models import User

from . import payment_services, services
from .models import WithdrawalRequest
from .serializers import (
    AdminAdjustSerializer,
    BankSerializer,
    DepositInitiateSerializer,
    LedgerEntrySerializer,
    PaymentIntentSerializer,
    PayoutAccountCreateSerializer,
    PayoutAccountSerializer,
    WalletBalanceSerializer,
    WithdrawalCreateSerializer,
    WithdrawalReverseSerializer,
    WithdrawalSerializer,
)


class WalletBalanceView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(WalletBalanceSerializer({"balance": services.get_balance(request.user)}).data)


class LedgerPagination(PageNumberPagination):
    page_size = 20
    max_page_size = 100


class LedgerListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs, page_size = services.list_ledger(request.user, page_size=request.query_params.get("page_size"))
        paginator = LedgerPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(LedgerEntrySerializer(page, many=True).data)


class AdminAdjustView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def post(self, request):
        serializer = AdminAdjustSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        user_id = data.pop("user_id")
        target = User.objects.filter(id=user_id).first()
        if target is None:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        entry = services.admin_adjust_wallet(request.user, target, **data)
        return Response(LedgerEntrySerializer(entry).data, status=status.HTTP_201_CREATED)


# ---------------------------------------------------------------------------
# Phase 6: payments. The Phase 5 placeholder `DepositView` (POST
# /wallet/deposit/, credited a wallet on nothing but the caller's own
# say-so) has been REMOVED per the explicit warning in its own
# docstring/README entry -- replaced by the initiate/webhook split
# below, where crediting only ever happens in payment_services after a
# provider signature check.
# ---------------------------------------------------------------------------
class DepositInitiateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def post(self, request):
        serializer = DepositInitiateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        intent = payment_services.initiate_deposit(request.user, **serializer.validated_data)
        return Response(PaymentIntentSerializer(intent).data, status=status.HTTP_201_CREATED)


class DepositListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs, page_size = payment_services.list_payment_intents(
            request.user, page_size=request.query_params.get("page_size")
        )
        paginator = LedgerPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(PaymentIntentSerializer(page, many=True).data)


@method_decorator(csrf_exempt, name="dispatch")
class DepositWebhookView(APIView):
    """
    Provider-facing endpoint, not a user action -- no session auth or
    CSRF protection applies (CSRF only guards against a browser
    carrying ambient session credentials to a forged request; a
    server-to-server webhook call carries neither). The real trust
    boundary is the provider signature check inside
    process_deposit_webhook, not Django auth or CSRF.
    """

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "payment_webhook"

    def post(self, request):
        intent = payment_services.process_deposit_webhook(headers=request.headers, body=request.body)
        if intent is None:
            return Response({"detail": "ignored"})
        return Response(PaymentIntentSerializer(intent).data)


@method_decorator(csrf_exempt, name="dispatch")
class WithdrawalWebhookView(APIView):
    """Monnify disbursement webhook (SUCCESSFUL / FAILED / REVERSED_DISBURSEMENT). Same trust
    model as DepositWebhookView: the signature check is the boundary. Set this URL as the
    disbursement-completion webhook in the Monnify dashboard."""

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "payment_webhook"

    def post(self, request):
        withdrawal = payment_services.process_payout_webhook(headers=request.headers, body=request.body)
        if withdrawal is None:
            return Response({"detail": "ignored"})
        return Response({"status": withdrawal.status})


class BankListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(BankSerializer(payment_services.list_banks(), many=True).data)


class PayoutAccountListCreateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def get(self, request):
        accounts = payment_services.list_payout_accounts(request.user)
        return Response(PayoutAccountSerializer(accounts, many=True).data)

    def post(self, request):
        serializer = PayoutAccountCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        account = payment_services.add_payout_account(request.user, **serializer.validated_data)
        return Response(PayoutAccountSerializer(account).data, status=status.HTTP_201_CREATED)


# The payout call to the provider must happen AFTER the wallet debit has committed, never inside
# one outer transaction. If settings has ATOMIC_REQUESTS = True this opts the withdrawal views out.
@method_decorator(transaction.non_atomic_requests, name="dispatch")
class WithdrawalListCreateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def get(self, request):
        qs, page_size = payment_services.list_withdrawals(
            request.user, page_size=request.query_params.get("page_size")
        )
        paginator = LedgerPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(WithdrawalSerializer(page, many=True).data)

    def post(self, request):
        serializer = WithdrawalCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        withdrawal = payment_services.request_withdrawal(request.user, **serializer.validated_data)
        return Response(WithdrawalSerializer(withdrawal).data, status=status.HTTP_201_CREATED)


class WithdrawalReverseView(APIView):
    """Staff-only. Authorization is enforced inside
    payment_services.reverse_withdrawal (matches this codebase's
    established pattern of role checks living in the service layer,
    e.g. resolve_dispute), not in permission_classes here."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "wallet_write"

    def post(self, request, withdrawal_id):
        serializer = WithdrawalReverseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            withdrawal = payment_services.reverse_withdrawal(
                request.user, withdrawal_id, **serializer.validated_data
            )
        except WithdrawalRequest.DoesNotExist as exc:
            raise NotFound("Withdrawal not found.") from exc
        return Response(WithdrawalSerializer(withdrawal).data)
