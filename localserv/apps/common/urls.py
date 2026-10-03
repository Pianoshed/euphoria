from django.urls import path

from . import views

app_name = "common"

urlpatterns = [
    path("healthz/", views.HealthCheckView.as_view(), name="healthz"),
]
