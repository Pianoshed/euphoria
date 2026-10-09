from django.urls import path

from . import views

app_name = "plans"

urlpatterns = [
    path("", views.PlanListCreateView.as_view(), name="list-create"),
    path("<uuid:service_id>/", views.PlanDetailView.as_view(), name="detail"),
    path("<uuid:service_id>/publish/", views.PlanPublishView.as_view(), name="publish"),
    path("<uuid:service_id>/cancel/", views.PlanCancelView.as_view(), name="cancel"),
    path("<uuid:service_id>/availability/", views.PlanAvailabilityView.as_view(), name="availability"),
]
