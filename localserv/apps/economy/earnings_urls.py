from django.urls import path
from . import views

urlpatterns = [
    path("", views.EarningListView.as_view(), name="earnings"),
    path("summary/", views.EarningSummaryView.as_view(), name="earnings-summary"),
    path("available/", views.AvailableEarningView.as_view(), name="earnings-available"),
    path("withdraw/", views.EarningWithdrawView.as_view(), name="earnings-withdraw"),
]
