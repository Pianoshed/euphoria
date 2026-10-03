from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.services import services as service_listing_services
from apps.services.serializers import ReviewCreateSerializer, ReviewSerializer

from . import services
from .serializers import (
    BookingCreateSerializer,
    BookingEventSerializer,
    BookingListQuerySerializer,
    BookingSerializer,
    BookingTransitionSerializer,
    DisputeResolveSerializer,
)


class BookingPagination(PageNumberPagination):
    page_size = 20
    max_page_size = 100


class BookingListCreateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def get(self, request):
        query_serializer = BookingListQuerySerializer(data=request.query_params)
        query_serializer.is_valid(raise_exception=True)
        params = query_serializer.validated_data

        qs, page_size = services.list_bookings_for_user(
            request.user,
            role_filter=params.get("role"),
            status_filter=params.get("status"),
            page_size=params.get("page_size"),
        )
        paginator = BookingPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(BookingSerializer(page, many=True).data)

    def post(self, request):
        serializer = BookingCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        booking = services.create_booking(request.user, **serializer.validated_data)
        return Response(BookingSerializer(booking).data, status=status.HTTP_201_CREATED)


class BookingDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, booking_id):
        booking = services.get_booking_for_participant(request.user, booking_id)
        if booking is None:
            raise NotFound("Booking not found.")
        return Response(BookingSerializer(booking).data)


class BookingTransitionView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def post(self, request, booking_id):
        serializer = BookingTransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        booking = services.transition_booking(request.user, booking_id, **serializer.validated_data)
        return Response(BookingSerializer(booking).data)


class BookingEventListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, booking_id):
        booking = services.get_booking_for_participant(request.user, booking_id)
        if booking is None:
            raise NotFound("Booking not found.")
        return Response(BookingEventSerializer(booking.events.all(), many=True).data)


class BookingFundView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def post(self, request, booking_id):
        booking = services.fund_booking(request.user, booking_id)
        return Response(BookingSerializer(booking).data)


class BookingReleaseFundsView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def post(self, request, booking_id):
        booking = services.release_booking_funds(request.user, booking_id)
        return Response(BookingSerializer(booking).data)


class BookingRefundCancelView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def post(self, request, booking_id):
        booking = services.refund_cancelled_booking(request.user, booking_id)
        return Response(BookingSerializer(booking).data)


class BookingDisputeResolveView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def post(self, request, booking_id):
        serializer = DisputeResolveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        booking = services.resolve_dispute(request.user, booking_id, **serializer.validated_data)
        return Response(BookingSerializer(booking).data)


class BookingReviewCreateView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "booking_write"

    def post(self, request, booking_id):
        serializer = ReviewCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        review = service_listing_services.create_review(
            request.user, booking_id=booking_id, **serializer.validated_data
        )
        return Response(ReviewSerializer(review).data, status=status.HTTP_201_CREATED)
