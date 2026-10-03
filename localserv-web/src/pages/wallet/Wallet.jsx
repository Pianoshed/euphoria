import '../../styles/index.css';
import { useEffect, useState } from 'react';
import * as walletApi from '../../api/wallet';
import { ErrorAlert, Spinner, StatusPill } from '../../components/ui';
import { formatNaira } from '../../utils/money';

// Flip both to false once wallet logic is finalized.
const SHOW_IN_PROGRESS_NOTICE = true;
// While true the page is visible but fully inert: nothing can be clicked, typed into, focused or submitted.
const WALLET_LOCKED = true;

export default function Wallet() {
  const [balance, setBalance] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [payoutAccounts, setPayoutAccounts] = useState(null);
  const [withdrawals, setWithdrawals] = useState(null);
  const [error, setError] = useState(null);

  const [depositAmount, setDepositAmount] = useState('');
  const [depositBusy, setDepositBusy] = useState(false);

  const [banks, setBanks] = useState([]);
  const [payoutForm, setPayoutForm] = useState({ bank_code: '', raw_account_number: '' });
  const [payoutBusy, setPayoutBusy] = useState(false);

  const [withdrawForm, setWithdrawForm] = useState({ amount: '', payout_account_id: '', current_password: '' });
  const [withdrawBusy, setWithdrawBusy] = useState(false);

  const loadAll = () => {
    walletApi.getBalance().then((b) => setBalance(b.balance)).catch(setError);
    walletApi.getLedger().then((l) => setLedger(l.results)).catch(setError);
    walletApi.listPayoutAccounts().then(setPayoutAccounts).catch(setError);
    walletApi.listWithdrawals().then((w) => setWithdrawals(w.results ?? w)).catch(setError);
  };

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
  }, []);

  const handleDeposit = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setDepositBusy(true);
    setError(null);
    try {
      const intent = await walletApi.initiateDeposit(depositAmount, walletApi.newIdempotencyKey());
      if (intent.checkout_url) {
        // Real provider: hand the user over to the hosted payment page.
        window.location.assign(intent.checkout_url);
        return;
      }
      setDepositAmount('');
      loadAll();
    } catch (err) {
      setError(err);
    } finally {
      setDepositBusy(false);
    }
  };

  const handleAddPayoutAccount = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setPayoutBusy(true);
    setError(null);
    try {
      const bank = banks.find((b) => b.code === payoutForm.bank_code);
      await walletApi.addPayoutAccount(bank?.name ?? '', payoutForm.raw_account_number, payoutForm.bank_code);
      setPayoutForm({ bank_code: '', raw_account_number: '' });
      loadAll();
    } catch (err) {
      setError(err);
    } finally {
      setPayoutBusy(false);
    }
  };

  const handleWithdraw = async (e) => {
    e.preventDefault();
    if (WALLET_LOCKED) return;
    setWithdrawBusy(true);
    setError(null);
    try {
      await walletApi.requestWithdrawal({ ...withdrawForm, idempotency_key: walletApi.newIdempotencyKey() });
      setWithdrawForm({ amount: '', payout_account_id: '', current_password: '' });
      loadAll();
    } catch (err) {
      setError(err);
    } finally {
      setWithdrawBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Your wallet</h1>
      <ErrorAlert error={error} />

      {SHOW_IN_PROGRESS_NOTICE && (
        <p
          className="text-sm muted"
          role="note"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            margin: '0 0 var(--space-4)',
            padding: '0.5rem 0.75rem',
            border: '1px dashed currentColor',
            borderRadius: '8px',
            opacity: 0.75,
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
        style={WALLET_LOCKED ? { pointerEvents: 'none', userSelect: 'none', opacity: 0.55 } : undefined}
      >
      <div className="card wallet-balance">
        <p className="muted">Available balance</p>
        <p className="price">
          {balance === null ? <Spinner /> : formatNaira(balance)}
        </p>
      </div>

      <div className="grid" style={{ marginBottom: 'var(--space-5)' }}>
        <div className="card stack">
          <h3>Top up</h3>
          <p className="text-sm muted">
            You'll be taken to a secure page to pay by card or bank transfer. Your balance
            updates as soon as the payment is confirmed.
          </p>
          {returnedFromCheckout && (
            <p className="text-sm" role="status">
              Thanks! We're confirming your payment. This can take a few seconds.
            </p>
          )}
          <form onSubmit={handleDeposit} className="form-row">
            <input type="number" min="100" step="0.01" inputMode="decimal" className="input" required placeholder="Amount (min ₦100)" aria-label="Amount to add"
              value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
            <button className="btn btn--primary" disabled={depositBusy} type="submit">
              {depositBusy ? 'Adding…' : 'Add funds'}
            </button>
          </form>
        </div>

        <div className="card stack">
          <h3>Where your money goes</h3>
          {payoutAccounts === null && <Spinner />}
          {payoutAccounts?.map((a) => (
            <p key={a.id} className="text-sm m-0 break">
              {a.label} · {a.masked_reference}{a.account_name ? ` · ${a.account_name}` : ''}
            </p>
          ))}
          {payoutAccounts?.length === 0 && (
            <p className="text-sm muted">No payout account on file yet — add one below so you can withdraw later.</p>
          )}
          <form onSubmit={handleAddPayoutAccount} className="stack-sm">
            <select className="select" aria-label="Bank" required value={payoutForm.bank_code}
              onChange={(e) => setPayoutForm((f) => ({ ...f, bank_code: e.target.value }))}>
              <option value="" disabled>Choose your bank</option>
              {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
            <input className="input" placeholder="Account number (10 digits)" inputMode="numeric" pattern="[0-9]{10}" maxLength={10}
              autoComplete="off" required value={payoutForm.raw_account_number}
              onChange={(e) => setPayoutForm((f) => ({ ...f, raw_account_number: e.target.value.replace(/\D/g, '') }))} />
            <span className="hint">We check the account name with your bank and store the number encrypted.</span>
            <button className="btn btn--sm" disabled={payoutBusy} type="submit">
              {payoutBusy ? 'Adding…' : 'Add payout account'}
            </button>
          </form>
        </div>
      </div>

      <div className="card stack" style={{ marginBottom: 'var(--space-6)' }}>
        <h3>Withdraw</h3>
        <p className="text-sm muted">
          A newly-added payout account can't be used for 24 hours. Your password is required to
          confirm a withdrawal. Transfers usually arrive within minutes; the status below updates
          from "processing" once your bank confirms.
        </p>
        <form onSubmit={handleWithdraw} className="stack-sm">
          <div className="form-row">
            <input type="number" min="500" step="0.01" inputMode="decimal" className="input"
              placeholder="Amount (min ₦500)" aria-label="Withdrawal amount" required
              value={withdrawForm.amount} onChange={(e) => setWithdrawForm((f) => ({ ...f, amount: e.target.value }))} />
            <select className="select" aria-label="Payout account" required
              value={withdrawForm.payout_account_id}
              onChange={(e) => setWithdrawForm((f) => ({ ...f, payout_account_id: e.target.value }))}>
              <option value="" disabled>Choose payout account</option>
              {payoutAccounts?.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.masked_reference}</option>)}
            </select>
            <input type="password" className="input" autoComplete="current-password" placeholder="Your password" aria-label="Your password" required
              value={withdrawForm.current_password} onChange={(e) => setWithdrawForm((f) => ({ ...f, current_password: e.target.value }))} />
          </div>
          <button className="btn btn--primary btn--block" disabled={withdrawBusy} type="submit">
            {withdrawBusy ? 'Requesting…' : 'Request withdrawal'}
          </button>
        </form>
        {withdrawals?.length > 0 && (
          <div className="stack-sm" style={{ marginTop: 'var(--space-3)' }}>
            {withdrawals.map((w) => (
              <p key={w.id} className="row row--wrap text-sm m-0">
                <span>{formatNaira(w.amount)} to {w.payout_account?.label}</span> <StatusPill status={w.status} />
              </p>
            ))}
          </div>
        )}
      </div>

      <h3>Activity</h3>
      {ledger === null && <Spinner />}
      {ledger?.length === 0 && <p className="muted text-sm">Nothing here yet — funding or getting paid for a hangout will show up in this list.</p>}
      <ul className="ledger">
        {ledger?.map((entry) => (
          <li key={entry.id} className="ledger__row">
            <span className="ledger__label">{entry.entry_type.replaceAll('_', ' ').toLowerCase()}{entry.note ? ` — ${entry.note}` : ''}</span>
            <span className={`amount${Number(entry.amount) < 0 ? '' : ' amount--in'}`}>
              {Number(entry.amount) >= 0 ? '+' : ''}{formatNaira(entry.amount)}
            </span>
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}