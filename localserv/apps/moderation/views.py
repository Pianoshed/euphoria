from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts import services as account_services
from apps.accounts.serializers import UserPublicSerializer
from apps.services import services as service_listing_services
from apps.services.serializers import ServiceSerializer
from apps.common.throttles import WriteScopedRateThrottle

from . import services
from .serializers import (
    ModerationReasonSerializer,
    ReportCreateSerializer,
    ReportListQuerySerializer,
    ReportResolveSerializer,
    ReportSerializer,
)


class ReportPagination(PageNumberPagination):
    page_size = 20
    max_page_size = 100


class ReportListCreateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def get(self, request):
        query_serializer = ReportListQuerySerializer(data=request.query_params)
        query_serializer.is_valid(raise_exception=True)
        params = query_serializer.validated_data

        qs, page_size = services.list_reports(
            request.user,
            status_filter=params.get("status"),
            target_type_filter=params.get("target_type"),
            ordering=params.get("ordering"),
            page_size=params.get("page_size"),
        )
        paginator = ReportPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(ReportSerializer(page, many=True).data)

    def post(self, request):
        serializer = ReportCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        report = services.create_report(request.user, **serializer.validated_data)
        return Response(ReportSerializer(report).data, status=status.HTTP_201_CREATED)


class ReportDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, report_id):
        report = services.get_report_for_staff(request.user, report_id)
        return Response(ReportSerializer(report).data)


class ReportResolveView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def post(self, request, report_id):
        serializer = ReportResolveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        report = services.resolve_report(request.user, report_id, **serializer.validated_data)
        return Response(ReportSerializer(report).data)


# --- Account moderation (delegates to apps.accounts.services) --------------------

class AccountSuspendView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def post(self, request, user_id):
        serializer = ModerationReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target = account_services.suspend_account(request.user, user_id, **serializer.validated_data)
        return Response(UserPublicSerializer(target).data)


class AccountBanView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def post(self, request, user_id):
        serializer = ModerationReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target = account_services.ban_account(request.user, user_id, **serializer.validated_data)
        return Response(UserPublicSerializer(target).data)


class AccountReinstateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def post(self, request, user_id):
        reason = request.data.get("reason", "") if isinstance(request.data, dict) else ""
        target = account_services.reinstate_account(request.user, user_id, reason=reason)
        return Response(UserPublicSerializer(target).data)


# --- Listing moderation (delegates to apps.services.services) --------------------

class ListingSuspendView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def post(self, request, service_id):
        serializer = ModerationReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        listing = service_listing_services.suspend_service(request.user, service_id, reason=serializer.validated_data["reason"])
        return Response(ServiceSerializer(listing).data)


class ListingUnsuspendView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "moderation_write"

    def post(self, request, service_id):
        listing = service_listing_services.unsuspend_service(request.user, service_id)
        return Response(ServiceSerializer(listing).data)
