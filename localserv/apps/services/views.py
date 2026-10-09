from rest_framework import serializers, status
from rest_framework.exceptions import NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common.constants import ServiceStatus

from . import services
from .models import Service, ServiceCategory
from .serializers import (
    ReviewSerializer,
    ServiceCategorySerializer,
    ServiceCreateSerializer,
    ServiceListQuerySerializer,
    ServiceSerializer,
    ServiceTransitionSerializer,
    ServiceUpdateSerializer,
)


class CategoryListView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        categories = ServiceCategory.objects.filter(is_active=True)
        return Response(ServiceCategorySerializer(categories, many=True).data)


class ServicePagination(PageNumberPagination):
    page_size = 20
    max_page_size = 100


class ServiceListCreateView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "service_write"

    def get_permissions(self):
        if self.request.method == "POST":
            return [IsAuthenticated()]
        return [AllowAny()]

    def get(self, request):
        query_serializer = ServiceListQuerySerializer(data=request.query_params)
        query_serializer.is_valid(raise_exception=True)
        params = query_serializer.validated_data

        qs, page_size = services.list_services(
            request.user if request.user.is_authenticated else None,
            category_id=params.get("category_id"),
            provider_id=params.get("provider_id"),
            query=params.get("q", ""),
            ordering=params.get("ordering"),
            page_size=params.get("page_size"),
            mine=params.get("mine", False),
        )
        paginator = ServicePagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(ServiceSerializer(page, many=True).data)

    def post(self, request):
        serializer = ServiceCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        service = services.create_service(request.user, **serializer.validated_data)
        return Response(ServiceSerializer(service).data, status=status.HTTP_201_CREATED)


class ServiceDetailView(APIView):
    def get_permissions(self):
        if self.request.method == "PATCH":
            return [IsAuthenticated()]
        return [AllowAny()]

    def get(self, request, service_id):
        service = services.get_visible_service(
            request.user if request.user.is_authenticated else None, service_id
        )
        if service is None:
            raise NotFound("Listing not found.")
        return Response(ServiceSerializer(service).data)

    def patch(self, request, service_id):
        service = Service.objects.filter(id=service_id).first()
        if service is None:
            raise NotFound("Listing not found.")
        serializer = ServiceUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = services.update_service(request.user, service, **serializer.validated_data)
        return Response(ServiceSerializer(updated).data)


class ServiceTransitionView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, service_id):
        serializer = ServiceTransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        service = services.transition_service_status(request.user, service_id, **serializer.validated_data)
        return Response(ServiceSerializer(service).data)


class ServiceSuspendSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=500, allow_blank=True, required=False)


class ServiceSuspendView(APIView):
    """Staff-only. Was previously implemented in services.services but
    had no URL wired to it -- unreachable via the API entirely.
    Fixed as part of the Phase 8 moderation pass."""

    permission_classes = [IsAuthenticated]

    def post(self, request, service_id):
        serializer = ServiceSuspendSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        service = services.suspend_service(request.user, service_id, **serializer.validated_data)
        return Response(ServiceSerializer(service).data)


class ServiceUnsuspendView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, service_id):
        service = services.unsuspend_service(request.user, service_id)
        return Response(ServiceSerializer(service).data)


class ServiceReviewListView(APIView):
    permission_classes = [AllowAny]

    def get(self, request, service_id):
        reviews = services.list_reviews_for_service(service_id)
        return Response(ReviewSerializer(reviews, many=True).data)


class PlanListCreateView(ServiceListCreateView):
    """Plan facade over the existing Service listing model.

    It reuses the existing service permission/status logic while forcing
    the plan flag so there is no duplicate Plan table or provider system.
    """

    def get(self, request):
        query_serializer = ServiceListQuerySerializer(data=request.query_params)
        query_serializer.is_valid(raise_exception=True)
        params = query_serializer.validated_data
        qs, page_size = services.list_services(
            request.user if request.user.is_authenticated else None,
            category_id=params.get("category_id"), provider_id=params.get("provider_id"),
            query=params.get("q", ""), ordering=params.get("ordering"),
            page_size=params.get("page_size"), mine=params.get("mine", False),
        )
        qs = qs.filter(is_plan=True)
        paginator = ServicePagination(); paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(ServiceSerializer(page, many=True).data)

    def post(self, request):
        serializer = ServiceCreateSerializer(data={**request.data, "is_plan": True})
        serializer.is_valid(raise_exception=True)
        plan = services.create_service(request.user, **serializer.validated_data)
        return Response(ServiceSerializer(plan).data, status=status.HTTP_201_CREATED)


class PlanDetailView(ServiceDetailView):
    def get(self, request, service_id):
        service = services.get_visible_service(request.user if request.user.is_authenticated else None, service_id)
        if service is None or not service.is_plan:
            raise NotFound("Plan not found.")
        return Response(ServiceSerializer(service).data)

    def patch(self, request, service_id):
        service = Service.objects.filter(id=service_id, is_plan=True).first()
        if service is None:
            raise NotFound("Plan not found.")
        serializer = ServiceUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.validated_data["is_plan"] = True
        updated = services.update_service(request.user, service, **serializer.validated_data)
        return Response(ServiceSerializer(updated).data)


class PlanAvailabilityView(APIView):
    def get(self, request, service_id):
        service = Service.objects.filter(id=service_id, is_plan=True).first()
        if service is None:
            raise NotFound("Plan not found.")
        from apps.economy.services import available_plan_slots
        return Response({"plan_id": str(service.id), "capacity": service.capacity, "available_slots": available_plan_slots(service)})


class PlanPublishView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, service_id):
        service = Service.objects.filter(id=service_id, is_plan=True).first()
        if service is None:
            raise NotFound("Plan not found.")
        service = services.transition_service_status(request.user, service_id, to_status=ServiceStatus.PUBLISHED)
        return Response(ServiceSerializer(service).data)


class PlanCancelView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, service_id):
        service = Service.objects.filter(id=service_id, is_plan=True).first()
        if service is None:
            raise NotFound("Plan not found.")
        service = services.transition_service_status(request.user, service_id, to_status=ServiceStatus.ARCHIVED)
        return Response(ServiceSerializer(service).data)
