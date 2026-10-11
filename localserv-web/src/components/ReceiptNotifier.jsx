import './receipts.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as walletApi from '../api/wallet';
import { useInboxEvent, useInboxSync } from '../hooks/useInboxSync';
import Modal from './Modal';
import { Icon } from './icons';
import { formatNaira } from '../utils/money';
import { creditHeadline, isCredit, ledgerLabel, receiptNumber } from '../utils/ledger';

const POLL_MS = 60_000; // only used while the live socket is down
const MAX_SHOWN = 3;
const AUTO_HIDE_MS = 12_000;
const seenKey = (uid) => `receipts-seen-v1:${uid}`;
const readSeen = (uid) => { try { const v = JSON.parse(localStorage.getItem(seenKey(uid))); return Array.isArray(v) ? v : null; } catch { return null; } };
const writeSeen = (uid, ids) => { try { localStorage.setItem(seenKey(uid), JSON.stringify(ids.slice(-300))); } catch { /* private mode */ } };

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
};

const receiptText = (e, who) => [
  'EUPHORIA RECEIPT',
  `Receipt no: ${receiptNumber(e)}`,
  `Type: ${ledgerLabel(e.entry_type)}`,
  `Amount: ${formatNaira(e.amount)}`,
  e.note ? `Note: ${e.note}` : null,
  `Date: ${when(e.created_at)}`,
  `Credited to: ${who}`,
  'Status: Successful',
].filter(Boolean).join('\n');

export function ReceiptSheet({ entry, who }) {
  const [copied, setCopied] = useState(false);
  const [icon, title] = creditHeadline(entry.entry_type);
  const text = receiptText(entry, who);

  const print = () => {
    document.body.classList.add('print-receipt');
    const done = () => { document.body.classList.remove('print-receipt'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };
  const share = () => { navigator.share?.({ title: 'Euphoria receipt', text }).catch(() => {}); };

  return (
    <div className="receipt-sheet">
      <div className="receipt-sheet__top">
        <span className="receipt-sheet__badge" aria-hidden="true"><Icon name={icon} size={26} /></span>
        <strong>{title}</strong>
        <span className="receipt-sheet__amt">+{formatNaira(entry.amount)}</span>
        <span className="receipt-sheet__status"><Icon name="check" size={14} /> Successful</span>
      </div>
      <dl className="receipt-sheet__rows">
        <div><dt>Receipt no.</dt><dd>{receiptNumber(entry)}</dd></div>
        <div><dt>Type</dt><dd>{ledgerLabel(entry.entry_type)}</dd></div>
        {entry.note && <div><dt>Note</dt><dd>{entry.note}</dd></div>}
        <div><dt>Date</dt><dd>{when(entry.created_at)}</dd></div>
        <div><dt>Credited to</dt><dd>{who}</dd></div>
      </dl>
      <p className="receipt-sheet__foot">Keep this receipt for your records. It is also listed in your wallet history.</p>
      <div className="receipt-sheet__acts">
        <button type="button" className="rcpt-btn rcpt-btn--solid" onClick={print}>Print / Save PDF</button>
        <button type="button" className="rcpt-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        {typeof navigator !== 'undefined' && navigator.share && <button type="button" className="rcpt-btn" onClick={share}>Share</button>}
      </div>
    </div>
  );
}

/**
 * Site-wide receipt popups. Renders nothing until money lands in the wallet
 * (top-up, bonus / platform credit, gift, plan payment, refund). Shows a toast with "View receipt".
 * Works from the wallet ledger, so it also catches credits that arrive while you are on another page.
 * The first check on a device only records what already exists, so old history never pops up.
 * Anything can ask for an instant check with: window.dispatchEvent(new Event('euphoria-wallet-changed'))
 */
export default function ReceiptNotifier() {
  const { user } = useAuth();
  const uid = user?.id;
  const who = user?.display_name || user?.username || 'You';
  const seenRef = useRef(null);
  const [toasts, setToasts] = useState([]);
  const [open, setOpen] = useState(null);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const check = useCallback(async () => {
    if (!uid) return;
    let rows;
    try {
      const data = await walletApi.getLedger();
      rows = data.results ?? data;
    } catch { return; } // offline / signed out: try next tick
    if (!Array.isArray(rows)) return;
    if (!seenRef.current) seenRef.current = readSeen(uid);
    if (!seenRef.current) { // first run on this device: baseline only
      seenRef.current = rows.map((r) => r.id);
      writeSeen(uid, seenRef.current);
      return;
    }
    const known = new Set(seenRef.current);
    const fresh = rows.filter((r) => !known.has(r.id));
    if (!fresh.length) return;
    seenRef.current = [...seenRef.current, ...fresh.map((r) => r.id)];
    writeSeen(uid, seenRef.current);
    const credits = fresh.filter(isCredit).reverse(); // oldest first
    if (credits.length) setToasts((t) => [...t, ...credits].slice(-MAX_SHOWN));
  }, [uid]);

  useEffect(() => {
    if (!uid) { setToasts([]); setOpen(null); seenRef.current = null; return undefined; }
    seenRef.current = null;
    const now = () => { check(); setTimeout(check, 3000); }; // webhooks can land a moment after the redirect
    window.addEventListener('euphoria-wallet-changed', now);
    return () => window.removeEventListener('euphoria-wallet-changed', now);
  }, [uid, check]);

  // The server says "wallet" the moment a credit lands; otherwise this is a slow safety refresh.
  // (Declared after the effect above so the seen-list is reset before the first check.)
  useInboxSync(check, { key: uid, fallbackMs: POLL_MS });
  useInboxEvent((e) => { if (e.type === 'wallet') check(); });

  // auto-hide each toast after a while
  useEffect(() => {
    if (!toasts.length) return undefined;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), AUTO_HIDE_MS));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);

  if (!uid) return null;
  return (
    <>
      <div className="rcpt-stack" aria-live="polite">
        {toasts.map((e) => {
          const [icon, title] = creditHeadline(e.entry_type);
          return (
            <div key={e.id} className="rcpt-toast" role="status">
              <span className="rcpt-toast__icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
              <p className="rcpt-toast__title">{title} <span className="rcpt-toast__amt">+{formatNaira(e.amount)}</span></p>
              <button type="button" className="rcpt-x" onClick={() => dismiss(e.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
              <p className="rcpt-toast__note">{e.note || ledgerLabel(e.entry_type)}</p>
              <div className="rcpt-toast__row">
                <button type="button" className="rcpt-btn rcpt-btn--solid" onClick={() => { setOpen(e); dismiss(e.id); }}>View receipt</button>
              </div>
            </div>
          );
        })}
      </div>
      {open && (
        <Modal title="Receipt" subtitle={receiptNumber(open)} onClose={() => setOpen(null)}>
          <ReceiptSheet entry={open} who={who} />
        </Modal>
      )}
    </>
  );
}
