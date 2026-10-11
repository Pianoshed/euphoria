import '../styles/index.css';
import './home-feed.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertsContext';
import * as squareApi from '../api/square';
import * as chatApi from '../api/chat';
import * as accountsApi from '../api/accounts';
import * as servicesApi from '../api/services';
import * as bookingsApi from '../api/bookings';
import * as walletApi from '../api/wallet';
import { API_BASE } from '../api/client';
import { formatNaira, formatPrice } from '../utils/money';
import { creditHeadline, isCredit, ledgerLabel, receiptNumber } from '../utils/ledger';
import { lookFor } from '../utils/bubbleLook';
import { usePageBackdrop } from '../hooks/usePageBackdrop';
import { Icon } from '../components/icons';
import Modal from '../components/Modal';
import { ReceiptSheet } from '../components/ReceiptNotifier';

const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();
const stamp = (iso) => { const t = new Date(iso).getTime(); return Number.isNaN(t) ? 0 : t; };
const ago = (iso) => {
  const t = stamp(iso);
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Late one';
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const rows = (d) => (Array.isArray(d) ? d : d?.results ?? []);

const CHAT_LIMIT = 3;
const PLAN_LIMIT = 6;
const DAY = 86_400_000;
const ACTIVE_BOOKING = new Set(['PENDING', 'ACCEPTED', 'FUNDED', 'IN_PROGRESS']);
const MISSED = new Set(['no_answer', 'busy', 'cancelled']);

const BOOKING_COPY = {
  PENDING: { tone: 'gold', text: 'is waiting for the host to say yes' },
  ACCEPTED: { tone: 'mint', text: 'was accepted. Fund it to lock it in' },
  FUNDED: { tone: 'sky', text: 'is confirmed' },
  IN_PROGRESS: { tone: 'pink', text: 'is happening now' },
};

// Everything that lives in the "Explore" drawer. Icons only, no emoji.
const SERVICES = [
  { to: '/square', icon: 'tree', label: 'Square' },
  { to: '/chat', icon: 'chat', label: 'Chats', alert: 'messages' },
  { to: '/services', icon: 'ticket', label: 'Browse plans' },
  { to: '/services/mine', icon: 'hand', label: 'Hosting' },
  { to: '/bookings', icon: 'check', label: 'Your plans' },
  { to: '/providers', icon: 'compass', label: 'Find people' },
  { to: '/calls', icon: 'phone', label: 'Calls', alert: 'missedCalls' },
  { to: '/wallet', icon: 'wallet', label: 'Wallet' },
];

// "Updates last opened" per person: credits that landed after it are flagged New.
const seenKey = (uid) => `hf-updates-seen-v2:${uid}`;
const readSeen = (uid) => { try { return Number(localStorage.getItem(seenKey(uid))) || Date.now() - DAY; } catch { return Date.now() - DAY; } };
const writeSeen = (uid, t) => { try { localStorage.setItem(seenKey(uid), String(t)); } catch { /* private mode */ } };

const daysLeft = (iso) => Math.ceil((stamp(iso) - Date.now()) / DAY);
const expiryText = (iso) => {
  if (!iso) return 'No expiry';
  const d = daysLeft(iso);
  if (d <= 0) return 'Expires today';
  return d === 1 ? 'Expires tomorrow' : `Expires in ${d} days`;
};

/** A panel that slides in from the right over a translucent scrim and disappears on tap-outside / Esc. */
function Drawer({ title, icon, onClose, children }) {
  const [leaving, setLeaving] = useState(false);
  const panel = useRef(null);
  const timer = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null);

  const close = useCallback(() => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = setTimeout(() => closeRef.current?.(), 180);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // a receipt dialog opened from inside handles its own Escape
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal')) close(); };
    window.addEventListener('keydown', key);
    panel.current?.focus({ preventScroll: true });
    const from = opener.current;
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = prev;
      clearTimeout(timer.current);
      if (from && typeof from.focus === 'function') from.focus({ preventScroll: true });
    };
  }, [close]);

  return (
    <div className={`hf-drawer${leaving ? ' is-leaving' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="hf-drawer__panel">
        <header className="hf-drawer__head">
          <span className="hf-ico" aria-hidden="true"><Icon name={icon} size={18} /></span>
          <h2>{title}</h2>
          <button type="button" className="hf-iconbtn" onClick={close} aria-label="Close"><Icon name="x" size={18} /></button>
        </header>
        <div className="hf-drawer__body">{children}</div>
      </aside>
    </div>
  );
}

/** One line: icon, words, time. Opens a receipt, or goes to the right page. */
function UpdateRow({ item, onReceipt }) {
  const body = (
    <>
      <span className="hf-ico" data-tint={item.tone} aria-hidden="true"><Icon name={item.icon} size={17} /></span>
      <span className="hf-row__text"><strong>{item.title}</strong><small>{item.text}</small></span>
      <span className="hf-row__meta">
        {item.time && <time>{ago(item.time)}</time>}
        {item.hot && <i className="hf-pip" aria-label="New" />}
      </span>
    </>
  );
  return item.receipt
    ? <button type="button" className="hf-row" onClick={() => onReceipt(item.receipt)}>{body}</button>
    : <Link to={item.to} className="hf-row">{body}</Link>;
}

export default function HomeFeed() {
  usePageBackdrop('scene');
  const { user } = useAuth();
  const alerts = useAlerts();
  const uid = user?.id;
  const fullName = user?.display_name || user?.username || '';
  const firstName = fullName.trim().split(/\s+/)[0] || 'there';
  const hello = useMemo(greeting, []);

  const [statuses, setStatuses] = useState(null);
  const [thoughts, setThoughts] = useState(null);
  const [trees, setTrees] = useState(null);
  const [plans, setPlans] = useState(null);
  const [chats, setChats] = useState(null);
  const [names, setNames] = useState({});
  const [mine, setMine] = useState([]);
  const [hosting, setHosting] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [balance, setBalance] = useState(null);       // paid wallet balance
  const [promo, setPromo] = useState(null);           // { promotional_balance, ... } or null while unknown
  const [promoCredits, setPromoCredits] = useState([]);
  const [seenAt, setSeenAt] = useState(() => readSeen(uid));
  const [drawer, setDrawer] = useState(null);         // 'updates' | 'explore' | null
  const [receipt, setReceipt] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // content that does not need to feel live (only used inside the Explore drawer)
  useEffect(() => {
    let off = false;
    const set = (fn) => (v) => { if (!off) fn(v); };
    squareApi.listStatuses().then(set(setStatuses)).catch(set(() => setStatuses([])));
    squareApi.listThoughts().then(set(setThoughts)).catch(set(() => setThoughts([])));
    squareApi.listTrees().then(set(setTrees)).catch(set(() => setTrees([])));
    servicesApi.listServices({}).then((d) => set(setPlans)(rows(d))).catch(set(() => setPlans([])));
    return () => { off = true; };
  }, []);

  // what is happening: chats, plans, wallet. Refreshed on focus, every 45s, when counts change, and when the wallet changes.
  const loadPulse = useCallback(async () => {
    const safe = (p) => p.catch(() => null);
    const [conv, own, host, led, bal, pb, pc] = await Promise.all([
      safe(chatApi.listConversations()),
      safe(bookingsApi.listBookings({ role: 'customer' })),
      safe(bookingsApi.listBookings({ role: 'provider' })),
      safe(walletApi.getLedger()),
      safe(walletApi.getBalance()),
      safe(walletApi.getPromotionalBalance()),
      safe(walletApi.listPromotionalCredits()),
    ]);
    if (own) setMine(rows(own).filter((b) => ACTIVE_BOOKING.has(b.status)));
    if (host) setHosting(rows(host).filter((b) => b.status === 'PENDING'));
    if (led) setLedger(rows(led).filter(isCredit).sort((a, b) => stamp(b.created_at) - stamp(a.created_at)));
    if (bal) setBalance(bal.balance);
    if (pb) setPromo(pb);
    if (pc) setPromoCredits(rows(pc));
    if (conv) {
      const list = [...rows(conv)].sort((a, b) => Number((b.unread_count || 0) > 0) - Number((a.unread_count || 0) > 0));
      setChats(list);
      const ids = [...new Set(list.slice(0, 6).filter((c) => !c.is_group && c.other_user_id).map((c) => c.other_user_id))];
      const got = await Promise.all(ids.map((id) => accountsApi.getPublicProfile(id).then((p) => [id, p.username || p.display_name]).catch(() => [id, null])));
      setNames((prev) => ({ ...prev, ...Object.fromEntries(got) }));
    } else {
      setChats((c) => c ?? []);
    }
  }, []);

  useEffect(() => {
    loadPulse();
    const tick = () => { if (document.visibilityState === 'visible') loadPulse(); };
    const timer = setInterval(tick, 45_000);
    const now = () => { loadPulse(); setTimeout(loadPulse, 3000); }; // top-ups can land a moment after the redirect
    window.addEventListener('focus', tick);
    window.addEventListener('euphoria-wallet-changed', now);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); window.removeEventListener('euphoria-wallet-changed', now); };
  }, [loadPulse]);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    loadPulse();
  }, [alerts.messages, alerts.missedCalls, loadPulse]);
  useEffect(() => { setSeenAt(readSeen(uid)); }, [uid]);

  // ---------- derived ----------
  const unreadChats = (chats || []).filter((c) => c.unread_count > 0);
  const shownChats = (chats || []).slice(0, CHAT_LIMIT);
  const hiddenChats = Math.max(0, (chats || []).length - shownChats.length);
  const chatName = (c) => (c.is_group ? (c.title || 'Group chat') : (names[c.other_user_id] || '…'));
  const chatPreview = (c) => {
    const last = c.last_message;
    return last ? (last.body === null ? 'Message deleted' : last.body || (last.attachment_type === 'audio' ? 'Voice message' : 'Photo')) : 'Nothing yet. Say hi.';
  };

  const recentCredits = useMemo(() => ledger.filter((e) => Date.now() - stamp(e.created_at) < 7 * DAY).slice(0, 5), [ledger]);
  const expiring = useMemo(() => promoCredits.filter((c) => num(c.remaining_amount) > 0 && c.expires_at && daysLeft(c.expires_at) <= 7), [promoCredits]);
  const bonus = promo ? num(promo.promotional_balance) : null;
  const nextPlan = mine[0] || null;
  const unseenStatuses = useMemo(() => {
    const seen = new Set();
    return (statuses || []).filter((s) => s.user.id !== uid && !s.seen && (seen.has(s.user.id) ? false : seen.add(s.user.id))).length;
  }, [statuses, uid]);

  // every notification, in one list: money first, then people who need an answer, then the rest
  const updates = useMemo(() => {
    const items = [];
    recentCredits.forEach((e) => {
      const [icon, title] = creditHeadline(e.entry_type);
      const at = stamp(e.created_at);
      items.push({
        key: `w${e.id}`, rank: 0, icon, tone: 'mint', hot: at > seenAt, receipt: e, at,
        title: `${title} +${formatNaira(e.amount)}`, text: `${e.note || ledgerLabel(e.entry_type)} · View receipt`, time: e.created_at,
      });
    });
    if (expiring.length) {
      const total = expiring.reduce((s, c) => s + num(c.remaining_amount), 0);
      const soonest = Math.min(...expiring.map((c) => daysLeft(c.expires_at)));
      items.push({
        key: 'expiring', rank: 1, icon: 'clock', tone: 'gold', hot: true, to: '/wallet', at: Date.now(),
        title: `${formatNaira(total)} bonus expiring`, text: soonest <= 0 ? 'Use it today on a plan' : `Use it within ${plural(soonest, 'day', 'days')} on a plan`, time: null,
      });
    }
    hosting.slice(0, 2).forEach((b) => items.push({
      key: `h${b.id}`, rank: 1, icon: 'hand', tone: 'gold', hot: true, to: `/bookings/${b.id}`, at: stamp(b.created_at),
      title: `${b.customer?.username || b.customer_username || 'Someone'} wants to join`, text: b.service_title, time: b.created_at,
    }));
    mine.forEach((b) => {
      const c = BOOKING_COPY[b.status];
      const hot = b.status === 'ACCEPTED';
      items.push({
        key: `b${b.id}${b.status}`, rank: hot ? 2 : 5, icon: 'ticket', tone: c.tone, hot, to: `/bookings/${b.id}`, at: stamp(b.updated_at || b.created_at),
        title: b.service_title, text: `${b.provider?.username ? `With ${b.provider.username} · ` : ''}${c.text}`, time: b.updated_at || b.created_at,
      });
    });
    if (alerts.messages > 0) {
      const who = unreadChats.slice(0, 2).map(chatName).filter((n) => n !== '…').join(' & ');
      items.push({
        key: 'msgs', rank: 3, icon: 'chat', tone: 'lilac', hot: true, at: stamp(unreadChats[0]?.last_message?.created_at),
        to: unreadChats.length === 1 ? `/chat/${unreadChats[0].id}` : '/chat',
        title: plural(alerts.messages, 'new message', 'new messages'), text: who ? `From ${who}` : 'Tap to read', time: unreadChats[0]?.last_message?.created_at,
      });
    }
    if (alerts.missedCalls > 0) {
      items.push({ key: 'calls', rank: 4, icon: 'phone', tone: 'coral', hot: true, to: '/calls', at: 0, title: plural(alerts.missedCalls, 'missed call', 'missed calls'), text: 'Since you last looked', time: null });
    }
    if (unseenStatuses > 0) {
      items.push({ key: 'status', rank: 6, icon: 'tree', tone: 'sky', hot: false, to: '/square', at: 0, title: `${plural(unseenStatuses, 'person', 'people')} posted a status`, text: 'See what your people are up to', time: null });
    }
    return items.sort((a, b) => Number(b.hot) - Number(a.hot) || a.rank - b.rank || b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentCredits, expiring, hosting, mine, alerts.messages, alerts.missedCalls, unreadChats.length, names, unseenStatuses, seenAt]);

  const needsYou = updates.filter((u) => u.hot);
  const topNeeds = needsYou.slice(0, 3);
  const hotCount = needsYou.length;

  const lead = alerts.messages > 0 ? `${plural(alerts.messages, 'message is', 'messages are')} waiting for you.`
    : alerts.missedCalls > 0 ? `You missed ${plural(alerts.missedCalls, 'call', 'calls')}.`
      : nextPlan ? `${nextPlan.service_title} ${BOOKING_COPY[nextPlan.status].text}.`
        : 'Nothing urgent right now.';

  const closeDrawer = () => {
    if (drawer === 'updates') { const t = Date.now(); writeSeen(uid, t); setSeenAt(t); }
    setDrawer(null);
  };

  const avatar = user?.avatar && !avatarFailed
    ? <img className="hf-me__img" src={`${API_BASE}${user.avatar}`} alt="" onError={() => setAvatarFailed(true)} />
    : <span className="hf-me__img" aria-hidden="true">{initial(fullName)}</span>;

  const rings = useMemo(() => {
    const seen = new Set();
    return (statuses || []).filter((s) => (seen.has(s.user.id) ? false : seen.add(s.user.id)))
      .sort((a, b) => Number(Boolean(a.seen)) - Number(Boolean(b.seen))).slice(0, 12);
  }, [statuses]);
  const myStatus = (statuses || []).some((s) => s.user.id === uid);
  const ownTrees = (trees || []).filter((t) => t.mine).length;
  const taggedTrees = (trees || []).length - ownTrees;
  const topThoughts = [...(thoughts || [])].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 3);

  return (
    <div className="page hf">
      <div className="hf-layout">
        {/* ---------- greeting + two doors: Updates and Explore ---------- */}
        <header className="hf-head">
          <Link to="/profile/me" className="hf-me" aria-label="Your profile">{avatar}</Link>
          <div className="hf-head__main">
            <p className="hf-head__hello">{hello}</p>
            <h1>Hey {firstName}<span className="hf-dot">.</span></h1>
            <p className="hf-head__sub">{lead}</p>
          </div>
          <div className="hf-head__btns">
            <button type="button" className="hf-iconbtn hf-iconbtn--lg" onClick={() => setDrawer('updates')} aria-label={hotCount ? `Updates, ${hotCount} new` : 'Updates'}>
              <Icon name="bell" size={20} />
              {hotCount > 0 && <b className="nb-count hf-iconbtn__count">{hotCount > 9 ? '9+' : hotCount}</b>}
            </button>
            <button type="button" className="hf-iconbtn hf-iconbtn--lg" onClick={() => setDrawer('explore')} aria-label="Explore">
              <Icon name="grid" size={20} />
            </button>
          </div>
        </header>

        <div className="hf-cols">
          <div className="hf-col">
            {/* ---------- wallet: the one place money is summarised ---------- */}
            <section className="hf-card hf-wallet" aria-label="Wallet" style={{ order: 1 }}>
              <div className="hf-wallet__top">
                <span className="hf-ico" data-tint="mint" aria-hidden="true"><Icon name="wallet" size={18} /></span>
                <span className="hf-wallet__label">Wallet balance</span>
                <Link to="/wallet" className="hf-link">Open<Icon name="chevron" size={14} /></Link>
              </div>
              <p className="hf-wallet__amount">{balance == null ? '–' : formatNaira(balance)}</p>
              {bonus > 0 && (
                <p className="hf-wallet__bonus">
                  <Icon name="gift" size={15} />
                  <span><b>{formatNaira(bonus)}</b> bonus credit<small> · spent first on plans, not withdrawable</small></span>
                </p>
              )}
              <div className="hf-wallet__acts">
                <Link to="/wallet" className="hf-btn hf-btn--solid"><Icon name="plus" size={16} />Add money</Link>
                <Link to="/services" className="hf-btn"><Icon name="ticket" size={16} />Find a plan</Link>
              </div>
            </section>

            {/* ---------- needs you: at most three things ---------- */}
            <section className="hf-card" aria-label="Needs your attention" style={{ order: 2 }}>
              <header className="hf-card__head">
                <h2>Needs you</h2>
                {updates.length > topNeeds.length || hotCount > 0
                  ? <button type="button" className="hf-link" onClick={() => setDrawer('updates')}>All updates<Icon name="chevron" size={14} /></button>
                  : null}
              </header>
              {topNeeds.length > 0
                ? <div className="hf-list">{topNeeds.map((u) => <UpdateRow key={u.key} item={u} onReceipt={setReceipt} />)}</div>
                : <p className="hf-hint"><Icon name="check" size={15} />You&rsquo;re all caught up.</p>}
            </section>

            {/* ---------- chats: three, unread first ---------- */}
            <section className="hf-card" aria-label="Chats" style={{ order: 3 }}>
              <header className="hf-card__head">
                <h2>Chats</h2>
                <Link to="/chat" className="hf-link">{unreadChats.length ? `${unreadChats.length} unread` : 'Inbox'}<Icon name="chevron" size={14} /></Link>
              </header>
              {chats && chats.length === 0 && <p className="hf-hint">No chats yet. Say hi to someone from <Link to="/providers">Find people</Link>.</p>}
              <div className="hf-list">
                {shownChats.map((c) => {
                  const unread = c.unread_count > 0;
                  const name = chatName(c);
                  return (
                    <Link key={c.id} to={`/chat/${c.id}`} className={`hf-row${unread ? ' is-unread' : ''}`}>
                      <span className="hf-av">{c.is_group ? <Icon name="users" size={17} /> : initial(name)}</span>
                      <span className="hf-row__text"><strong>{name}</strong><small>{chatPreview(c)}</small></span>
                      {unread && <b className="nb-count hf-row__count">{c.unread_count > 99 ? '99+' : c.unread_count}</b>}
                    </Link>
                  );
                })}
              </div>
              {hiddenChats > 0 && <Link to="/chat" className="hf-more">+{hiddenChats} more in your inbox<Icon name="chevron" size={14} /></Link>}
            </section>
          </div>

          <div className="hf-col">
            {/* ---------- fresh plans: the one thing that invites a tap ---------- */}
            <section className="hf-sec" aria-label="Fresh plans" style={{ order: 4 }}>
              <header className="hf-card__head hf-card__head--bare">
                <h2>Fresh plans</h2>
                <Link to="/services" className="hf-link">Browse<Icon name="chevron" size={14} /></Link>
              </header>
              {plans && plans.length === 0 && <p className="hf-hint">No plans posted yet. <Link to="/services/mine/new">Host the first one</Link>.</p>}
              <div className="hf-plans">
                {(plans || []).slice(0, PLAN_LIMIT).map((p) => (
                  <Link key={p.id} to={`/services/${p.id}`} className="hf-plan" data-tint={lookFor(p.id, 0).tint.name}>
                    <span className="hf-plan__top">
                      <small>{p.category?.name}</small>
                      <b>{formatPrice(p.price)}</b>
                    </span>
                    <strong>{p.title}</strong>
                    <small className="hf-plan__host">Hosted by {p.provider?.username || 'someone'}</small>
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* ---------- Updates drawer: every notification, plus the exact credit details ---------- */}
      {drawer === 'updates' && (
        <Drawer title="Updates" icon="bell" onClose={closeDrawer}>
          {updates.length === 0 && <p className="hf-hint">Messages, calls, plan updates and wallet credits will show up here as they happen.</p>}
          <div className="hf-list">{updates.map((u) => <UpdateRow key={u.key} item={u} onReceipt={setReceipt} />)}</div>

          <h3 className="hf-drawer__sub">Your money</h3>
          <dl className="hf-money">
            <div><dt>Wallet balance</dt><dd>{balance == null ? '–' : formatNaira(balance)}</dd></div>
            <div><dt>Bonus credit</dt><dd>{bonus == null ? '–' : formatNaira(bonus)}</dd></div>
          </dl>
          {promoCredits.length > 0 && (
            <ul className="hf-credits">
              {promoCredits.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <span className="hf-ico" data-tint="gold" aria-hidden="true"><Icon name="gift" size={16} /></span>
                  <span className="hf-row__text">
                    <strong>{c.plan_title || c.category_name || (c.code ? `Code ${c.code}` : 'Platform credit')}</strong>
                    <small>{expiryText(c.expires_at)}</small>
                  </span>
                  <b>{formatNaira(c.remaining_amount)}</b>
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      )}

      {/* ---------- Explore drawer: services and everything that is not urgent ---------- */}
      {drawer === 'explore' && (
        <Drawer title="Explore" icon="grid" onClose={closeDrawer}>
          <nav className="hf-services" aria-label="Services">
            {SERVICES.map((s) => (
              <Link key={s.to} to={s.to} className="hf-service">
                <span className="hf-ico" aria-hidden="true"><Icon name={s.icon} size={20} /></span>
                <span>{s.label}</span>
                {s.alert && alerts[s.alert] > 0 && <b className="nb-count hf-service__count">{alerts[s.alert] > 99 ? '99+' : alerts[s.alert]}</b>}
              </Link>
            ))}
          </nav>

          <h3 className="hf-drawer__sub">On the Square</h3>
          <div className="hf-rings" aria-label="Statuses from your people">
            <Link to="/square" className="hf-ring hf-ring--add">
              <span className="hf-ring__o"><span className="hf-ring__i">{myStatus ? initial(fullName) : <Icon name="plus" size={20} />}</span></span>
              <small>{myStatus ? 'Your status' : 'Add status'}</small>
            </Link>
            {rings.map((s) => (
              <Link key={s.user.id} to="/square" className={`hf-ring${s.seen ? ' is-seen' : ''}`}>
                <span className="hf-ring__o"><span className="hf-ring__i">{initial(s.user.name)}</span></span>
                <small>{s.user.id === uid ? 'You' : s.user.name}</small>
              </Link>
            ))}
          </div>
          <Link to="/square" className="hf-row hf-row--flat">
            <span className="hf-ico" data-tint="mint" aria-hidden="true"><Icon name="tree" size={17} /></span>
            <span className="hf-row__text">
              <strong>{trees == null ? 'Loading your trees…'
                : ownTrees + taggedTrees === 0 ? 'Plant a friend tree'
                  : `${plural(ownTrees, 'tree', 'trees')} planted`}</strong>
              <small>{ownTrees + taggedTrees === 0 ? 'See your people\'s statuses' : taggedTrees ? `Tagged in ${taggedTrees}` : 'Open the Square'}</small>
            </span>
          </Link>

          {topThoughts.length > 0 && (
            <>
              <h3 className="hf-drawer__sub">Top thoughts</h3>
              <div className="hf-list">
                {topThoughts.map((t) => (
                  <Link to="/square" key={t.id} className="hf-thought">
                    <p>{t.text.length > 110 ? `${t.text.slice(0, 110)}…` : t.text}</p>
                    <small><b>{t.user.name}</b> · {ago(t.created_at)} · <Icon name="flame" size={13} /> {t.total || 0}</small>
                  </Link>
                ))}
              </div>
            </>
          )}
        </Drawer>
      )}

      {receipt && (
        <Modal title="Receipt" subtitle={receiptNumber(receipt)} onClose={() => setReceipt(null)}>
          <ReceiptSheet entry={receipt} who={fullName || 'You'} />
        </Modal>
      )}
    </div>
  );
}
