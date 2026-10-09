from django.urls import path
from . import views

urlpatterns = [
    path("", views.GiftListCreateView.as_view(), name="gifts"),
    path("<uuid:gift_id>/<str:action>/", views.GiftActionView.as_view(), name="gift-action"),
]
