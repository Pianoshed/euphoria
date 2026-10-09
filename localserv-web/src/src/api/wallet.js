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
