from django.urls import path

from . import views

app_name = "economy"

urlpatterns = [
    path("wallet/promotional-balance/", views.PromotionalBalanceView.as_view(), name="promotional-balance"),
    path("wallet/promotional-credits/grant/", views.PromotionalCreditGrantView.as_view(), name="promotional-credit-grant"),
    path("orders/", views.OrderListView.as_view(), name="orders"),
    path("earnings/", views.EarningListView.as_view(), name="earnings"),
    path("earnings/summary/", views.EarningSummaryView.as_view(), name="earnings-summary"),
    path("earnings/available/", views.AvailableEarningView.as_view(), name="earnings-available"),
    path("earnings/withdraw/", views.EarningWithdrawView.as_view(), name="earnings-withdraw"),
    path("gifts/", views.GiftListCreateView.as_view(), name="gifts"),
    path("gifts/<uuid:gift_id>/<str:action>/", views.GiftActionView.as_view(), name="gift-action"),
]
