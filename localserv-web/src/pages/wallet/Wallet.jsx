import '../../styles/index.css';
import './wallet.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as walletApi from '../../api/wallet';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner, StatusPill } from '../../components/ui';
import Modal from '../../components/Modal';
import { formatNaira } from '../../utils/money';
import { goToCheckout } from '../../utils/safeRedirect';

// Flip both to false once wallet logic is finalized.
const SHOW_IN_PROGRESS_NOTICE = true;
// While true the page is visible but fully inert: nothing can be clicked, typed into, focused or submitted,
// and none of the dialogs can open. (Every rule below mirrors the backend: apps/wallet/payment_services.py.)
const WALLET_LOCKED = true;

// Mirrors MIN_DEPOSIT, MIN_WITHDRAWAL and PAYOUT_ACCOUNT_COOLDOWN_HOURS on the server. The server stays the judge.
const MIN_DEPOSIT = 100;
const MIN_WITHDRAWAL = 500;
const COOLDOWN_HOURS = 24;

const LEDGER_LABELS = {
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
const ledgerLabel = (type) => LEDGER_LABELS[type] || type.replaceAll('_', ' ').toLowerCase();

const hoursLeft = (createdAt) => {
  const ms = new Date(createdAt).getTime() + COOLDOWN_HOURS * 3600 * 1000 - Date.now();
  return ms > 0 ? Math.ceil(ms / 3600000) : 0;
};

/** One dialog layout: a coloured sidebar (big emoji + the facts that matter) next to the form. */
function WalletDialog({ emoji, title, subtitle, facts, notes, onClose, children }) {
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} wide>
      <div className="wm">
        <aside className="wm__side">
          <span className="wm__emoji" aria-hidden="true">{emoji}</span>
          <h3>{title}</h3>
          {facts.map((f) => <p key={f.label}>{f.label}: <b>{f.value}</b></p>)}
          {notes?.length > 0 && <ul>{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </aside>
        <div className="wm__main">{children}</div>
      </div>
    </Modal>
  );
}

export default function Wallet() {
  const { user } = useAuth();
  const holder = user?.display_name || user?.username || 'You';

  const [balance, setBalance] = useState(null);
  const [credits, setCredits] = useState(null);
  const [creditList, setCreditList] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [pendingTopUps, setPendingTopUps] = useState([]);
  const [payoutAccounts, setPayoutAccounts] = useState(null);
  const [withdrawals, setWithdrawals] = useState(null);
  const [banks, setBanks] = useState([]);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // 'topup' | 'bank' | 'withdraw'

  const [depositAmount, setDepositAmount] = useState('');
  const [payoutForm, setPayoutForm] = useState({ bank_code: '', raw_account_number: '' });
  const [withdrawForm, setWithdrawForm] = useState({ source: 'WALLET', amount: '', payout_account_id: '', current_password: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState(null);
  const [promoDone, setPromoDone] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  // One key per attempt, reused if the same request is retried after a bad network, so money can never move twice.
  const depositKey = useRef(null);
  const withdrawKey = useRef(null);

  const loadAll = useCallback(() => {
    walletApi.getBalance().then((b) => setBalance(b.balance)).catch(setError);
    walletApi.getPromotionalBalance().then(setCredits).catch(() => setCredits(null));
    walletApi.listPromotionalCredits().then(setCreditList).catch(() => setCreditList([]));
    walletApi.getEarningsSummary().then(setEarnings).catch(() => setEarnings(null));
    walletApi.getLedger().then((l) => setLedger(l.results)).catch(setError);
    walletApi.listDeposits().then((d) => setPendingTopUps((d.results ?? d).filter((x) => x.status === 'PENDING'))).catch(() => setPendingTopUps([]));
    walletApi.listPayoutAccounts().then(setPayoutAccounts).catch(setError);
    walletApi.listWithdrawals().then((w) => setWithdrawals(w.results ?? w)).catch(setError);
  }, []);

  useEffect(() => {
    walletApi.listBanks().then(setBanks).catch(() => setBanks([]));
  }, []);

  // After paying on Monnify's hosted page the user lands back here (?deposit=return).
  // The webhook is what credits the wallet, and it can arrive a few seconds after the
  // redirect, so refresh a few times instead of showing a stale balance.
  const returnedFromCheckout = new URLSearchParams(window.location.search).get('deposit') === 'return';

  useEffect(() => {
    loadAll();
    if (!returnedFromCheckout) return undefined;
    let tries = 0;
    const timer = setInterval(() => {
      loadAll();
      tries += 1;
      if (tries >= 5) clearInterval(timer);
    }, 3000);
    return () => clearInterval(timer);
  }, [loadAll, returnedFromCheckout]);

  const openDialog = (name) => {
    if (WALLET_LOCKED) return;
    setDialogError(null);
    if (name === 'topup') depositKey.current = walletApi.newIdempotencyKey();
    if (name === 'withdraw') withdrawKey.current = walletApi.newIdempotencyKey();
    setDialog(name);
  };
  const closeDialog = () => { setDialog(null); setDialogError(null); };

  const handleDeposit = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setBusy(true);
    setDialogError(null);
    try {
      const intent = await walletApi.initiateDeposit(depositAmount, depositKey.current);
      if (intent.checkout_url) {
        // Real provider: hand the user over to the hosted payment page.
        if (!goToCheckout(intent.checkout_url)) throw new Error('The payment page could not be verified. Nothing was charged. Please try again.');
        return;
      }
      setDepositAmount('');
      closeDialog();
      loadAll();
    } catch (err) {
      setDialogError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleAddPayoutAccount = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setBusy(true);
    setDialogError(null);
    try {
      const bank = banks.find((b) => b.code === payoutForm.bank_code);
      await walletApi.addPayoutAccount(bank?.name ?? '', payoutForm.raw_account_number, payoutForm.bank_code);
      setPayoutForm({ bank_code: '', raw_account_number: '' });
      closeDialog();
      loadAll();
    } catch (err) {
      setDialogError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleRedeem = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setPromoBusy(true);
    setPromoError(null);
    setPromoDone(null);
    try {
      const res = await walletApi.redeemPromoCode(promoCode);
      setPromoDone(res);
      setPromoCode('');
      loadAll();
    } catch (err) {
      setPromoError(err);
    } finally {
      setPromoBusy(false);
    }
  };

  const handleWithdraw = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setBusy(true);
    setDialogError(null);
    try {
      const { code, source, ...fields } = withdrawForm;
      const body = {
        ...fields,
        ...(user?.two_factor_enabled ? { otp_code: code.trim() } : {}),
        idempotency_key: withdrawKey.current,
      };
      // Wallet money and planner earnings are paid out through different endpoints on the server.
      if (source === 'EARNINGS') await walletApi.withdrawEarnings(body);
      else await walletApi.requestWithdrawal(body);
      setWithdrawForm({ source: 'WALLET', amount: '', payout_account_id: '', current_password: '', code: '' });
      closeDialog();
      loadAll();
    } catch (err) {
      setDialogError(err);
    } finally {
      setBusy(false);
    }
  };

  const availableEarnings = Number(earnings?.available) || 0;
  const promoTotal = Number(credits?.promotional_balance) || 0;
  const readyAccounts = payoutAccounts?.filter((a) => hoursLeft(a.created_at) === 0) ?? [];

  return (
    <div className="page wl">
      <h1>Your wallet</h1>
      <ErrorAlert error={error} onRetry={() => { setError(null); loadAll(); }} />

      {SHOW_IN_PROGRESS_NOTICE && (
        <p
          className="text-sm muted"
          role="note"
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 var(--space-4)', padding: '0.5rem 0.75rem',
            border: '1px dashed currentColor', borderRadius: '8px', opacity: 0.85,
          }}
        >
          <span aria-hidden="true">🚧</span>
          <span>
            {WALLET_LOCKED
              ? 'Wallet is temporarily unavailable while we finish building it. Nothing here can be used yet.'
              : 'Wallet is still in progress. Some features may change or behave unexpectedly while we finalize things.'}
          </span>
        </p>
      )}

      <div
        inert={WALLET_LOCKED}
        aria-disabled={WALLET_LOCKED || undefined}
        style={WALLET_LOCKED ? { pointerEvents: 'none', userSelect: 'none', opacity: 0.8 } : undefined}
      >
        <div className="wl-layout">
          <nav className="wl-side" aria-label="Wallet sections">
            <div className="wl-side__brand"><span aria-hidden="true">👛</span><span>Wallet</span></div>
            <a href="#wl-overview"><span aria-hidden="true">💰</span>Overview</a>
            <a href="#wl-banks"><span aria-hidden="true">🏦</span>Bank accounts</a>
            <a href="#wl-promo"><span aria-hidden="true">🎁</span>Promo credits</a>
            <a href="#wl-earnings"><span aria-hidden="true">💸</span>Earnings</a>
            <a href="#wl-activity"><span aria-hidden="true">🧾</span>Activity</a>
          </nav>

          <div className="wl-main">
            <section className="wl-hero" id="wl-overview">
              <div className="wl-hero__top">
                <span className="wl-hero__emoji" aria-hidden="true">💰</span>
                <div>
                  <p className="wl-hero__who">Wallet of <b>{holder}</b></p>
                  <p className="wl-hero__label">Available balance</p>
                  <p className="wl-hero__amount">{balance === null ? <Spinner /> : formatNaira(balance)}</p>
                </div>
              </div>
              {promoTotal > 0 && (
                <p className="wl-hero__promo">
                  🎁 + {formatNaira(credits.promotional_balance)} platform credits. Spent first on plans; they can't be withdrawn.
                </p>
              )}
              <div className="wl-hero__acts">
                <button type="button" className="btn btn--primary" disabled={WALLET_LOCKED} onClick={() => openDialog('topup')}>➕ Add money</button>
                <button type="button" className="btn" disabled={WALLET_LOCKED} onClick={() => openDialog('withdraw')}>🏧 Withdraw</button>
              </div>
            </section>

            <section className="wl-card" id="wl-banks">
              <h2><span className="wl-emoji" aria-hidden="true">🏦</span>Bank accounts</h2>
              <p className="text-sm muted">Where withdrawals are sent. New accounts can be used after {COOLDOWN_HOURS} hours.</p>
              {payoutAccounts === null && <Spinner />}
              {payoutAccounts?.map((a) => {
                const wait = hoursLeft(a.created_at);
                return (
                  <div key={a.id} className="wl-row">
                    <span>
                      <b>{a.account_name || holder}</b>
                      <small>{a.label} · {a.masked_reference}</small>
                    </span>
                    <span className="pill pill--neutral">{wait ? `Ready in ~${wait}h` : 'Ready'}</span>
                  </div>
                );
              })}
              {payoutAccounts?.length === 0 && <p className="text-sm muted">No bank account yet. Add one so you can withdraw later.</p>}
              <div><button type="button" className="btn btn--sm" disabled={WALLET_LOCKED} onClick={() => openDialog('bank')}>➕ Add bank account</button></div>
            </section>

            <section className="wl-card" id="wl-promo">
              <h2><span className="wl-emoji" aria-hidden="true">🎁</span>Promo credits</h2>
              <p className="text-sm muted">Platform credits you've been given. They're spent before your own money and can't be withdrawn.</p>
              {creditList === null && <Spinner />}
              {creditList?.map((c) => (
                <div key={c.id} className="wl-row">
                  <span>
                    <b>{c.source.replaceAll('_', ' ')}</b>
                    <small>
                      {c.plan_title ? `For ${c.plan_title}` : c.category_name ? `For ${c.category_name} plans` : 'Works on any plan'}
                      {c.expires_at ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}` : ' · no expiry'}
                    </small>
                    {c.code && <span className="wl-code">{c.code}</span>}
                  </span>
                  <b>{formatNaira(c.remaining_amount)}</b>
                </div>
              ))}
              {creditList?.length === 0 && <p className="text-sm muted">No promo credits right now.</p>}
              <form className="wl-promo-input" onSubmit={handleRedeem}>
                <input className="input" placeholder="Promo code" aria-label="Promo code" autoComplete="off" maxLength={60}
                  disabled={WALLET_LOCKED} required value={promoCode} onChange={(e) => setPromoCode(e.target.value)} />
                <button type="submit" className="btn btn--sm btn--primary" disabled={WALLET_LOCKED || promoBusy}>{promoBusy ? 'Checking…' : 'Redeem'}</button>
              </form>
              <ErrorAlert error={promoError} />
              {promoDone && <p className="text-sm" role="status">🎉 {promoDone.name}: {formatNaira(promoDone.amount)} added to your platform credits.</p>}
              {WALLET_LOCKED && <p className="wl-lock"><span aria-hidden="true">🔒</span>Redeeming is switched off while the wallet is locked.</p>}
            </section>

            <section className="wl-card" id="wl-earnings">
              <h2><span className="wl-emoji" aria-hidden="true">💸</span>Earnings from your plans</h2>
              {earnings === null ? <Spinner /> : (
                <>
                  <div className="wl-row"><span>Ready to withdraw</span><b>{formatNaira(earnings.available)}</b></div>
                  <div className="wl-row"><span>Still pending</span><b>{formatNaira(earnings.pending)}</b></div>
                  <p className="text-sm muted">Money guests pay for plans you host lands here, not in your balance. Withdraw it from the Withdraw window.</p>
                </>
              )}
            </section>

            <section className="wl-card" id="wl-activity">
              <h2><span className="wl-emoji" aria-hidden="true">🧾</span>Activity</h2>
              {pendingTopUps.map((p) => (
                <div key={p.id} className="wl-row">
                  <span>Top-up of {formatNaira(p.amount)}<small>Waiting for your bank to confirm</small></span>
                  <StatusPill status={p.status} />
                </div>
              ))}
              {withdrawals?.map((w) => (
                <div key={w.id} className="wl-row">
                  <span>
                    {formatNaira(w.amount)} to {w.payout_account?.account_name || w.payout_account?.label}
                    <small>{w.source === 'EARNINGS' ? 'From earnings' : 'From balance'}{w.failure_reason ? ` · ${w.failure_reason}` : ''}</small>
                  </span>
                  <StatusPill status={w.status} />
                </div>
              ))}
              {ledger === null && <Spinner />}
              {ledger?.length === 0 && <p className="muted text-sm">Nothing here yet. Topping up or getting paid for a plan will show up in this list.</p>}
              <ul className="ledger">
                {ledger?.map((entry) => (
                  <li key={entry.id} className="ledger__row">
                    <span className="ledger__label">{ledgerLabel(entry.entry_type)}{entry.note ? ` — ${entry.note}` : ''}</span>
                    <span className={`amount${Number(entry.amount) < 0 ? '' : ' amount--in'}`}>
                      {Number(entry.amount) >= 0 ? '+' : ''}{formatNaira(entry.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>

      {/* ---------- Dialogs (cannot open while WALLET_LOCKED) ---------- */}
      {dialog === 'topup' && (
        <WalletDialog
          emoji="💰" title="Add money" subtitle="Pay by card or bank transfer" onClose={closeDialog}
          facts={[{ label: 'Balance', value: formatNaira(balance ?? 0) }, { label: 'Minimum', value: formatNaira(MIN_DEPOSIT) }]}
          notes={['You pay on a secure page', 'Your balance updates once the payment is confirmed']}
        >
          <ErrorAlert error={dialogError} />
          {returnedFromCheckout && <p className="text-sm" role="status">Thanks! We're confirming your payment. This can take a few seconds.</p>}
          <form onSubmit={handleDeposit}>
            <input type="number" min={MIN_DEPOSIT} step="0.01" inputMode="decimal" className="input" required
              placeholder={`Amount (min ₦${MIN_DEPOSIT})`} aria-label="Amount to add"
              value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
            <button className="btn btn--primary" disabled={busy} type="submit">{busy ? 'Opening…' : 'Continue to payment'}</button>
          </form>
        </WalletDialog>
      )}

      {dialog === 'bank' && (
        <WalletDialog
          emoji="🏦" title="Add bank account" subtitle="We check the name with your bank" onClose={closeDialog}
          facts={[{ label: 'Saved accounts', value: `${payoutAccounts?.length ?? 0} / 5` }, { label: 'Usable after', value: `${COOLDOWN_HOURS} hours` }]}
          notes={['The account number is stored encrypted', 'Only a masked copy is ever shown']}
        >
          <ErrorAlert error={dialogError} />
          <form onSubmit={handleAddPayoutAccount}>
            <select className="select" aria-label="Bank" required value={payoutForm.bank_code}
              onChange={(e) => setPayoutForm((f) => ({ ...f, bank_code: e.target.value }))}>
              <option value="" disabled>Choose your bank</option>
              {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
            <input className="input" placeholder="Account number (10 digits)" inputMode="numeric" pattern="[0-9]{10}" maxLength={10}
              autoComplete="off" required value={payoutForm.raw_account_number}
              onChange={(e) => setPayoutForm((f) => ({ ...f, raw_account_number: e.target.value.replace(/\D/g, '') }))} />
            <button className="btn btn--primary" disabled={busy} type="submit">{busy ? 'Checking…' : 'Add account'}</button>
          </form>
        </WalletDialog>
      )}

      {dialog === 'withdraw' && (
        <WalletDialog
          emoji="🏧" title="Withdraw" subtitle="Send money to your bank" onClose={closeDialog}
          facts={[
            { label: 'Balance', value: formatNaira(balance ?? 0) },
            { label: 'Earnings', value: formatNaira(availableEarnings) },
            { label: 'Minimum', value: formatNaira(MIN_WITHDRAWAL) },
          ]}
          notes={[
            `Bank accounts work ${COOLDOWN_HOURS}h after adding`,
            `Your password${user?.two_factor_enabled ? ' and authenticator code are' : ' is'} needed`,
            'Platform credits can\'t be withdrawn',
          ]}
        >
          <ErrorAlert error={dialogError} />
          <form onSubmit={handleWithdraw}>
            <select className="select" aria-label="Withdraw from" value={withdrawForm.source}
              onChange={(e) => setWithdrawForm((f) => ({ ...f, source: e.target.value }))}>
              <option value="WALLET">From my balance ({formatNaira(balance ?? 0)})</option>
              <option value="EARNINGS" disabled={availableEarnings <= 0}>From my earnings ({formatNaira(availableEarnings)})</option>
            </select>
            <input type="number" min={MIN_WITHDRAWAL} step="0.01" inputMode="decimal" className="input"
              placeholder={`Amount (min ₦${MIN_WITHDRAWAL})`} aria-label="Withdrawal amount" required
              value={withdrawForm.amount} onChange={(e) => setWithdrawForm((f) => ({ ...f, amount: e.target.value }))} />
            <select className="select" aria-label="Bank account" required value={withdrawForm.payout_account_id}
              onChange={(e) => setWithdrawForm((f) => ({ ...f, payout_account_id: e.target.value }))}>
              <option value="" disabled>Choose bank account</option>
              {readyAccounts.map((a) => <option key={a.id} value={a.id}>{a.account_name || holder} · {a.label} {a.masked_reference}</option>)}
            </select>
            {payoutAccounts?.length > 0 && readyAccounts.length === 0 && (
              <span className="hint">Your new bank account becomes usable {COOLDOWN_HOURS} hours after you add it.</span>
            )}
            <input type="password" className="input" autoComplete="current-password" placeholder="Your password" aria-label="Your password" required
              value={withdrawForm.current_password} onChange={(e) => setWithdrawForm((f) => ({ ...f, current_password: e.target.value }))} />
            {user?.two_factor_enabled && (
              <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required
                placeholder="Authenticator code" aria-label="Authenticator code"
                value={withdrawForm.code} onChange={(e) => setWithdrawForm((f) => ({ ...f, code: e.target.value.replace(/\s/g, '') }))} />
            )}
            <button className="btn btn--primary" disabled={busy} type="submit">{busy ? 'Requesting…' : 'Request withdrawal'}</button>
          </form>
        </WalletDialog>
      )}
    </div>
  );
}
