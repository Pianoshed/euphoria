import { apiFetch } from './client';

export const getBalance = () => apiFetch('/api/wallet/balance/');

export const getLedger = (params) => apiFetch('/api/wallet/ledger/', { query: params });

export const initiateDeposit = (amount, idempotency_key) =>
  apiFetch('/api/wallet/deposits/', { method: 'POST', body: { amount, idempotency_key } });

export const listDeposits = () => apiFetch('/api/wallet/deposits/mine/');

export const listBanks = () => apiFetch('/api/wallet/banks/');

export const listPayoutAccounts = () => apiFetch('/api/wallet/payout-accounts/');

export const addPayoutAccount = (label, raw_account_number, bank_code) =>
  apiFetch('/api/wallet/payout-accounts/', {
    method: 'POST',
    body: { label, raw_account_number, bank_code },
  });

export const listWithdrawals = () => apiFetch('/api/wallet/withdrawals/');

export const requestWithdrawal = (fields) =>
  apiFetch('/api/wallet/withdrawals/', { method: 'POST', body: fields });

/** Generates a fresh idempotency key per user action -- see README for why
 * every write here takes one (protects against double-submit on a slow network). */
export const newIdempotencyKey = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);


// Platform (promotional) credits: { paid_balance, promotional_balance, total_usable, promotional_withdrawable }.
// Plan bookings spend these first, then the paid balance.
export const getPromotionalBalance = () => apiFetch('/api/economy/wallet/promotional-balance/');

// The caller's live platform credits: [{ id, source, code, original_amount, remaining_amount, expires_at, plan_title, category_name, withdrawable }].
export const listPromotionalCredits = () => apiFetch('/api/economy/wallet/promotional-credits/');

// Planner earnings (money from plans you host). Paid out through their own endpoint, never the wallet balance.
export const getEarningsSummary = () => apiFetch('/api/economy/earnings/summary/'); // { pending, available, settled }
export const withdrawEarnings = (fields) =>
  apiFetch('/api/economy/earnings/withdraw/', { method: 'POST', body: fields });

// Redeem a promo code -> platform credit (spendable on plans, never withdrawable). One use per person.
export const redeemPromoCode = (code) => apiFetch('/api/wallet/promo-codes/redeem/', { method: 'POST', body: { code } });
