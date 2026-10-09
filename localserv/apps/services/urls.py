from django.urls import path

from . import views

app_name = "services"

urlpatterns = [
    path("categories/", views.CategoryListView.as_view(), name="categories"),
    path("plans/", views.PlanListCreateView.as_view(), name="plans"),
    path("plans/<uuid:service_id>/", views.PlanDetailView.as_view(), name="plan-detail"),
    path("plans/<uuid:service_id>/availability/", views.PlanAvailabilityView.as_view(), name="plan-availability"),
    path("", views.ServiceListCreateView.as_view(), name="list-create"),
    path("<uuid:service_id>/", views.ServiceDetailView.as_view(), name="detail"),
    path("<uuid:service_id>/transition/", views.ServiceTransitionView.as_view(), name="transition"),
    path("<uuid:service_id>/suspend/", views.ServiceSuspendView.as_view(), name="suspend"),
    path("<uuid:service_id>/unsuspend/", views.ServiceUnsuspendView.as_view(), name="unsuspend"),
    path("<uuid:service_id>/reviews/", views.ServiceReviewListView.as_view(), name="reviews"),
]
