from django.urls import path

from . import views

app_name = "moderation"

urlpatterns = [
    path("reports/", views.ReportListCreateView.as_view(), name="reports"),
    path("reports/<uuid:report_id>/", views.ReportDetailView.as_view(), name="report-detail"),
    path("reports/<uuid:report_id>/resolve/", views.ReportResolveView.as_view(), name="report-resolve"),
    path("users/<uuid:user_id>/suspend/", views.AccountSuspendView.as_view(), name="account-suspend"),
    path("users/<uuid:user_id>/ban/", views.AccountBanView.as_view(), name="account-ban"),
    path("users/<uuid:user_id>/reinstate/", views.AccountReinstateView.as_view(), name="account-reinstate"),
    path("services/<uuid:service_id>/suspend/", views.ListingSuspendView.as_view(), name="listing-suspend"),
    path("services/<uuid:service_id>/unsuspend/", views.ListingUnsuspendView.as_view(), name="listing-unsuspend"),
]
