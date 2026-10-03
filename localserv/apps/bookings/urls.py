from django.urls import path

from . import views

app_name = "bookings"

urlpatterns = [
    path("", views.BookingListCreateView.as_view(), name="list-create"),
    path("<uuid:booking_id>/", views.BookingDetailView.as_view(), name="detail"),
    path("<uuid:booking_id>/transition/", views.BookingTransitionView.as_view(), name="transition"),
    path("<uuid:booking_id>/fund/", views.BookingFundView.as_view(), name="fund"),
    path("<uuid:booking_id>/release/", views.BookingReleaseFundsView.as_view(), name="release"),
    path("<uuid:booking_id>/refund-cancel/", views.BookingRefundCancelView.as_view(), name="refund-cancel"),
    path("<uuid:booking_id>/resolve-dispute/", views.BookingDisputeResolveView.as_view(), name="resolve-dispute"),
    path("<uuid:booking_id>/events/", views.BookingEventListView.as_view(), name="events"),
    path("<uuid:booking_id>/review/", views.BookingReviewCreateView.as_view(), name="review"),
]
