// Wallet ledger helpers shared by the Wallet page and the receipt notifications.
export const LEDGER_LABELS = {
  TOKEN_DEPOSIT: 'Top-up',
  ESCROW_HOLD: 'Locked in for a plan',
  ESCROW_RELEASE: 'Plan payment received',
  ESCROW_REFUND: 'Plan refund',
  PLAN_PAYMENT: 'Plan payment',
  PLAN_REFUND: 'Plan refund',
  WITHDRAWAL: 'Withdrawal',
  WITHDRAWAL_REFUND: 'Withdrawal returned',
  WITHDRAWAL_REVERSAL: 'Withdrawal returned',
  PROMOTIONAL_CREDIT: 'Platform credit',
  PROMOTIONAL_DEBIT: 'Platform credit used',
  GIFT_CREDIT: 'Gift received',
  GIFT_DEBIT: 'Gift sent',
  ADMIN_ADJUSTMENT: 'Adjustment by support',
};

export const ledgerLabel = (type = '') => LEDGER_LABELS[type] || String(type).replaceAll('_', ' ').toLowerCase();

// Money coming IN to the person (credit / bonus / refund / top-up / payout received).
export const isCredit = (entry) => Number(entry?.amount) > 0;

const HEADLINES = {
  PROMOTIONAL_CREDIT: ['🎁', 'Bonus received'],
  GIFT_CREDIT: ['💝', 'Gift received'],
  TOKEN_DEPOSIT: ['💰', 'Top-up successful'],
  ESCROW_RELEASE: ['✅', 'Payment received'],
  ESCROW_REFUND: ['↩️', 'Refund received'],
  PLAN_REFUND: ['↩️', 'Refund received'],
  WITHDRAWAL_REFUND: ['↩️', 'Withdrawal returned'],
  WITHDRAWAL_REVERSAL: ['↩️', 'Withdrawal returned'],
  ADMIN_ADJUSTMENT: ['🧾', 'Wallet credited'],
};
export const creditHeadline = (type) => HEADLINES[type] || ['💳', 'Wallet credited'];

export const receiptNumber = (entry) => `EUP-${String(entry?.id ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase().padStart(8, '0')}`;
