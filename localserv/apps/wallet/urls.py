from django.urls import path

from . import views

app_name = "wallet"

urlpatterns = [
    path("balance/", views.WalletBalanceView.as_view(), name="balance"),
    path("ledger/", views.LedgerListView.as_view(), name="ledger"),
    path("admin-adjust/", views.AdminAdjustView.as_view(), name="admin-adjust"),
    # Phase 6 -- deposit/ (the old self-serve placeholder) intentionally removed.
    path("deposits/", views.DepositInitiateView.as_view(), name="deposit-initiate"),
    path("deposits/mine/", views.DepositListView.as_view(), name="deposit-list"),
    path("deposits/webhook/", views.DepositWebhookView.as_view(), name="deposit-webhook"),
    path("payout-accounts/", views.PayoutAccountListCreateView.as_view(), name="payout-accounts"),
    path("withdrawals/", views.WithdrawalListCreateView.as_view(), name="withdrawals"),
    path("withdrawals/<uuid:withdrawal_id>/reverse/", views.WithdrawalReverseView.as_view(), name="withdrawal-reverse"),
    path("banks/", views.BankListView.as_view(), name="banks"),
    path("withdrawals/webhook/", views.WithdrawalWebhookView.as_view(), name="withdrawal-webhook"),
]
