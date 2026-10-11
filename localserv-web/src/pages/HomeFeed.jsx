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
const ago = (iso) => {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const m = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const stamp = (iso) => { const t = new Date(iso).getTime(); return Number.isNaN(t) ? 0 : t; };
const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Late one';
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CHAT_LIMIT = 4;
const DAY = 86_400_000;
const ACTIVE_BOOKING = new Set(['PENDING', 'ACCEPTED', 'FUNDED', 'IN_PROGRESS']);
const MISSED = new Set(['no_answer', 'busy', 'cancelled']);
const SWATCH = ['gold', 'coral', 'lilac', 'mint', 'sky'];
const swatchFor = (key) => { let h = 0; String(key).split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; }); return SWATCH[h % SWATCH.length]; };

const BOOKING_COPY = {
  PENDING: { tone: 'gold', text: 'is waiting for the host to say yes' },
  ACCEPTED: { tone: 'mint', text: 'was accepted. Fund it to lock it in' },
  FUNDED: { tone: 'sky', text: 'is confirmed' },
  IN_PROGRESS: { tone: 'pink', text: 'is happening now' },
};

const ACTIONS = [
  { to: '/square', icon: 'tree', label: 'Square', tone: 'mint' },
  { to: '/chat', icon: 'chat', label: 'Chats', tone: 'lilac', alert: 'messages' },
  { to: '/services', icon: 'ticket', label: 'Plans', tone: 'gold' },
  { to: '/providers', icon: 'compass', label: 'Find people', tone: 'sky' },
  { to: '/calls', icon: 'phone', label: 'Calls', tone: 'coral', alert: 'missedCalls' },
  { to: '/wallet', icon: 'wallet', label: 'Wallet', tone: 'pink' },
];

const dismissKey = (uid) => `hf-snacks-dismissed-v1:${uid}`;
const readDismissed = (uid) => { try { const v = JSON.parse(localStorage.getItem(dismissKey(uid))); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeDismissed = (uid, list) => { try { localStorage.setItem(dismissKey(uid), JSON.stringify(list.slice(-80))); } catch { /* private mode */ } };

function Section({ title, to, cta = 'See all', id, children }) {
  return (
    <section className="hf-sec" id={id}>
      <header className="hf-sec__head">
        <h2>{title}</h2>
        {to && <Link to={to}>{cta}<Icon name="chevron" size={14} /></Link>}
      </header>
      {children}
    </section>
  );
}

/** One notification line: icon bubble, words, time. A translucent wash fades in from the side bar. */
function PulseRow({ item, onOpenReceipt }) {
  const body = (
    <>
      <span className="hf-pulse__ico" aria-hidden="true"><Icon name={item.icon} size={16} /></span>
      <span className="hf-pulse__text"><strong>{item.title}</strong><small>{item.text}</small></span>
      <span className="hf-pulse__meta">{item.time && <time>{ago(item.time)}</time>}{item.hot && <i className="hf-pip" aria-label="New" />}</span>
    </>
  );
  const cls = `hf-pulse__row hf-fill${item.hot ? ' is-hot' : ''}`;
  return item.receipt
    ? <button type="button" className={cls} data-tint={item.tone} onClick={() => onOpenReceipt(item.receipt)}>{body}</button>
    : <Link to={item.to} className={cls} data-tint={item.tone}>{body}</Link>;
}

export default function HomeFeed() {
  usePageBackdrop('scene'); // same night-scene artwork as the page before login
  const { user } = useAuth();
  const alerts = useAlerts();
  const uid = user?.id;
  const fullName = user?.display_name || user?.username || '';
  const firstName = fullName.trim().split(/\s+/)[0] || 'there';
  const hello = useMemo(greeting, []);

  const [statuses, setStatuses] = useState(null);
  const [thoughts, setThoughts] = useState(null);
  const [trees, setTrees] = useState(null);
  const [chats, setChats] = useState(null);
  const [names, setNames] = useState({});
  const [plans, setPlans] = useState(null);
  const [mine, setMine] = useState([]);      // my bookings (as guest)
  const [hosting, setHosting] = useState([]); // bookings on plans I host
  const [calls, setCalls] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [balance, setBalance] = useState(null);
  const [dismissed, setDismissed] = useState(() => readDismissed(uid));
  const [receipt, setReceipt] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // content that does not need to feel live
  useEffect(() => {
    let off = false;
    const set = (fn) => (v) => { if (!off) fn(v); };
    squareApi.listStatuses().then(set(setStatuses)).catch(set(() => setStatuses([])));
    squareApi.listThoughts().then(set(setThoughts)).catch(set(() => setThoughts([])));
    squareApi.listTrees().then(set(setTrees)).catch(set(() => setTrees([])));
    servicesApi.listServices({}).then((d) => set(setPlans)(d.results ?? d)).catch(set(() => setPlans([])));
    return () => { off = true; };
  }, []);

  // what is happening: chats, calls, plans, wallet. Refreshed when counts change, on focus, and every 45s.
  const loadPulse = useCallback(async () => {
    const safe = (p, fallback) => p.catch(() => fallback);
    const [conv, callRes, own, host, led, bal] = await Promise.all([
      safe(chatApi.listConversations(), null),
      safe(chatApi.listCallLogs({ scope: 'mine', page: 1 }), null),
      safe(bookingsApi.listBookings({ role: 'customer' }), null),
      safe(bookingsApi.listBookings({ role: 'provider' }), null),
      safe(walletApi.getLedger(), null),
      safe(walletApi.getBalance(), null),
    ]);
    if (callRes) setCalls(callRes.results ?? callRes);
    if (own) setMine((own.results ?? own).filter((b) => ACTIVE_BOOKING.has(b.status)));
    if (host) setHosting((host.results ?? host).filter((b) => b.status === 'PENDING'));
    if (led) setLedger((led.results ?? led).filter(isCredit));
    if (bal) setBalance(bal.balance);
    if (conv) {
      const all = conv.results ?? conv;
      // unread first (stable), then the rest in inbox order
      const list = [...all].sort((a, b) => Number((b.unread_count || 0) > 0) - Number((a.unread_count || 0) > 0));
      setChats(list);
      const ids = [...new Set(list.slice(0, CHAT_LIMIT).filter((c) => !c.is_group && c.other_user_id).map((c) => c.other_user_id))];
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
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [loadPulse]);
  // refresh right away when the unread / missed counts change (skip the first run: the effect above already loaded)
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    loadPulse();
  }, [alerts.messages, alerts.missedCalls, loadPulse]);
  useEffect(() => { setDismissed(readDismissed(uid)); }, [uid]);

  // ---------- derived ----------
  const rings = useMemo(() => {
    const seen = new Set();
    return (statuses || []).filter((s) => (seen.has(s.user.id) ? false : seen.add(s.user.id)))
      .sort((a, b) => Number(Boolean(a.seen)) - Number(Boolean(b.seen))).slice(0, 14);
  }, [statuses]);
  const myStatus = (statuses || []).some((s) => s.user.id === uid);
  const unseenStatuses = rings.filter((s) => !s.seen && s.user.id !== uid).length;
  const ownTrees = (trees || []).filter((t) => t.mine).length;
  const taggedTrees = (trees || []).length - ownTrees;
  const topThoughts = [...(thoughts || [])].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 3);

  const shownChats = (chats || []).slice(0, CHAT_LIMIT);
  const hiddenChats = Math.max(0, (chats || []).length - shownChats.length);
  const unreadChats = (chats || []).filter((c) => c.unread_count > 0);
  const chatName = (c) => (c.is_group ? (c.title || 'Group chat') : (names[c.other_user_id] || '…'));
  const chatPreview = (c) => {
    const last = c.last_message;
    return last ? (last.body === null ? 'Message deleted' : last.body || (last.attachment_type === 'audio' ? 'Voice message' : 'Photo')) : 'Nothing yet. Say hi.';
  };

  const missedRows = useMemo(
    () => calls.filter((r) => r.callee === uid && MISSED.has(r.outcome) && Date.now() - stamp(r.started_at) < 3 * DAY).slice(0, 3),
    [calls, uid],
  );
  const recentCredits = useMemo(() => ledger.filter((e) => Date.now() - stamp(e.created_at) < 7 * DAY).slice(0, 3), [ledger]);
  const nextPlan = mine[0] || null;

  // the "Happening now" feed
  const pulse = useMemo(() => {
    const items = [];
    unreadChats.slice(0, 3).forEach((c) => items.push({
      key: `c${c.id}`, icon: 'chat', tone: 'lilac', hot: true, to: `/chat/${c.id}`,
      title: chatName(c), text: `${plural(c.unread_count, 'new message', 'new messages')} · ${chatPreview(c)}`,
      time: c.last_message?.created_at || c.updated_at, at: stamp(c.last_message?.created_at || c.updated_at),
    }));
    missedRows.forEach((r) => items.push({
      key: `m${r.id}`, icon: 'phone', tone: 'coral', hot: true, to: '/calls',
      title: r.caller_username || 'Someone', text: 'Missed call', time: r.started_at, at: stamp(r.started_at),
    }));
    hosting.slice(0, 2).forEach((b) => items.push({
      key: `h${b.id}`, icon: 'hand', tone: 'gold', hot: true, to: `/bookings/${b.id}`,
      title: `${b.customer?.username || b.customer_username || 'Someone'} wants to join`, text: b.service_title,
      time: b.created_at, at: stamp(b.created_at),
    }));
    mine.slice(0, 2).forEach((b) => {
      const c = BOOKING_COPY[b.status];
      items.push({
        key: `b${b.id}${b.status}`, icon: 'ticket', tone: c.tone, hot: b.status === 'ACCEPTED', to: `/bookings/${b.id}`,
        title: b.service_title, text: `${b.provider?.username ? `With ${b.provider.username} · ` : ''}${c.text}`,
        time: b.updated_at || b.created_at, at: stamp(b.updated_at || b.created_at),
      });
    });
    recentCredits.forEach((e) => {
      const [, title] = creditHeadline(e.entry_type);
      items.push({
        key: `w${e.id}`, icon: 'wallet', tone: 'mint', hot: Date.now() - stamp(e.created_at) < DAY, receipt: e,
        title: `${title} +${formatNaira(e.amount)}`, text: `${e.note || ledgerLabel(e.entry_type)} · tap for receipt`,
        time: e.created_at, at: stamp(e.created_at),
      });
    });
    if (unseenStatuses > 0) items.push({
      key: 's', icon: 'tree', tone: 'sky', hot: false, to: '/square',
      title: `${plural(unseenStatuses, 'person', 'people')} posted a status`, text: 'See what your people are up to', time: null, at: 0,
    });
    return items.sort((a, b) => b.at - a.at).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadChats.length, names, missedRows, hosting, mine, recentCredits, unseenStatuses]);
  const hotCount = pulse.filter((p) => p.hot).length;

  // snack bars: the few things worth interrupting for, dismissible
  const snacks = useMemo(() => {
    const out = [];
    const newest = recentCredits.find((e) => Date.now() - stamp(e.created_at) < DAY);
    if (newest) {
      const [icon, title] = creditHeadline(newest.entry_type);
      out.push({ key: `credit:${newest.id}`, tone: 'mint', emoji: icon, text: <><b>{title}</b> +{formatNaira(newest.amount)}</>, act: 'Receipt', onAct: () => setReceipt(newest) });
    }
    const ask = hosting[0];
    if (ask) out.push({ key: `ask:${ask.id}`, tone: 'gold', icon: 'hand', text: <><b>{ask.customer?.username || ask.customer_username || 'Someone'}</b> wants to join {ask.service_title}</>, act: 'Review', to: `/bookings/${ask.id}` });
    const acc = mine.find((b) => b.status === 'ACCEPTED');
    if (acc) out.push({ key: `acc:${acc.id}`, tone: 'pink', icon: 'ticket', text: <><b>{acc.service_title}</b> was accepted. Fund it to lock your spot</>, act: 'Open', to: `/bookings/${acc.id}` });
    if (alerts.messages > 0) {
      const who = unreadChats.slice(0, 2).map(chatName).filter((n) => n !== '…').join(' & ');
      out.push({ key: `msgs:${alerts.messages}`, tone: 'lilac', icon: 'chat', text: <><b>{plural(alerts.messages, 'new message', 'new messages')}</b>{who ? ` from ${who}` : ''}</>, act: 'Reply', to: unreadChats.length === 1 ? `/chat/${unreadChats[0].id}` : '/chat' });
    }
    if (alerts.missedCalls > 0) out.push({ key: `calls:${alerts.missedCalls}`, tone: 'coral', icon: 'phone', text: <><b>{plural(alerts.missedCalls, 'missed call', 'missed calls')}</b> since you last looked</>, act: 'Call log', to: '/calls' });
    const visible = out.filter((s) => !dismissed.includes(s.key)).slice(0, 3);
    if (visible.length === 0 && statuses && chats) {
      const k = `calm:${new Date().toDateString()}`;
      if (!dismissed.includes(k)) visible.push({ key: k, tone: 'sky', icon: 'sparkle', text: <><b>You&rsquo;re all caught up.</b> Good time to find a plan</>, act: 'Browse', to: '/services' });
    }
    return visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentCredits, hosting, mine, alerts.messages, alerts.missedCalls, unreadChats.length, names, dismissed, statuses, chats]);

  const dismiss = (key) => { const next = [...dismissed, key]; setDismissed(next); writeDismissed(uid, next); };

  const lead = alerts.messages > 0 ? `${plural(alerts.messages, 'message is', 'messages are')} waiting for you.`
    : missedRows.length ? `You missed ${plural(missedRows.length, 'call', 'calls')} while you were away.`
      : nextPlan ? `${nextPlan.service_title} ${BOOKING_COPY[nextPlan.status].text}.`
        : 'Nothing urgent. Plenty to look forward to.';

  const avatar = user?.avatar && !avatarFailed
    ? <img className="hf-me__img" src={`${API_BASE}${user.avatar}`} alt="" onError={() => setAvatarFailed(true)} />
    : <span className="hf-me__img" aria-hidden="true">{initial(fullName)}</span>;

  return (
    <div className="page hf">
      <div className="hf-layout">
        <div className="hf-top">
          {/* ---------- greeting: soft glass, no boxes ---------- */}
          <header className="hf-hero" data-tint="pink">
            <div className="hf-hero__row">
              <Link to="/profile/me" className="hf-me" aria-label="Your profile">{avatar}</Link>
              <div className="hf-hero__main">
                <p className="hf-hero__hello">{hello}</p>
                <h1>Hey {firstName}<span className="hf-dot">.</span></h1>
                <p className="hf-hero__sub">{lead}</p>
              </div>
            </div>
            <div className="hf-chips" role="group" aria-label="Today at a glance">
              <Link to="/chat" className={`hf-chip hf-fill${alerts.messages > 0 ? ' is-hot' : ''}`} data-tint="lilac">
                <Icon name="chat" size={15} /><b>{alerts.messages || 0}</b><span>{alerts.messages === 1 ? 'message' : 'messages'}</span>
              </Link>
              <Link to="/calls" className={`hf-chip hf-fill${alerts.missedCalls > 0 ? ' is-hot' : ''}`} data-tint="coral">
                <Icon name="phone" size={15} /><b>{alerts.missedCalls || 0}</b><span>missed</span>
              </Link>
              <Link to="/wallet" className="hf-chip hf-fill" data-tint="mint">
                <Icon name="wallet" size={15} /><b>{balance != null ? formatPrice(balance) : '–'}</b><span>wallet</span>
              </Link>
            </div>
            <div className="hf-hero__cta">
              <Link to="/services" className="hf-btn hf-btn--solid"><Icon name="ticket" size={18} />Find a plan</Link>
              <Link to="/square" className="hf-btn"><Icon name="tree" size={18} />Open the Square</Link>
            </div>
          </header>

          {/* ---------- snack bars ---------- */}
          {snacks.length > 0 && (
            <div className="hf-snacks" aria-live="polite">
              {snacks.map((s, i) => (
                <div key={s.key} className="hf-snack hf-fill" data-tint={s.tone} style={{ '--i': i }} role="status">
                  <span className="hf-snack__ico" aria-hidden="true">{s.emoji || <Icon name={s.icon} size={16} />}</span>
                  <p className="hf-snack__text">{s.text}</p>
                  {s.to && <Link to={s.to} className="hf-snack__act">{s.act}</Link>}
                  {s.onAct && <button type="button" className="hf-snack__act" onClick={s.onAct}>{s.act}</button>}
                  <button type="button" className="hf-snack__x" onClick={() => dismiss(s.key)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
                </div>
              ))}
            </div>
          )}

          {/* ---------- quick actions (the desktop sidebar already has these) ---------- */}
          <nav className="hf-actions" aria-label="Quick actions">
            {ACTIONS.map((a) => (
              <Link key={a.to} to={a.to} className="hf-act hf-fill" data-tint={a.tone}>
                <span className="hf-act__icon" aria-hidden="true"><Icon name={a.icon} size={17} /></span>
                <span className="hf-act__label">{a.label}</span>
                {a.alert && alerts[a.alert] > 0 && <b className="nb-count">{alerts[a.alert] > 99 ? '99+' : alerts[a.alert]}</b>}
              </Link>
            ))}
          </nav>
        </div>

        {/* ---------- side rail: what is happening right now ---------- */}
        <aside className="hf-pulse" aria-label="Happening now">
          <section className="hf-glass">
            <header className="hf-glass__head">
              <h2>Happening now</h2>
              {hotCount > 0 ? <span className="hf-badge">{hotCount} new</span> : <span className="hf-badge hf-badge--calm">All caught up</span>}
            </header>
            {pulse.length === 0 && <p className="hf-hint">Messages, calls, plan updates and wallet credits will show up here as they happen.</p>}
            <div className="hf-pulse__list">
              {pulse.map((p) => <PulseRow key={p.key} item={p} onOpenReceipt={setReceipt} />)}
            </div>
          </section>

          <section className="hf-glass">
            <header className="hf-glass__head">
              <h2>Chats</h2>
              <Link to="/chat" className="hf-glass__link">{unreadChats.length ? `${unreadChats.length} unread` : 'Inbox'}<Icon name="chevron" size={14} /></Link>
            </header>
            {chats && chats.length === 0 && <p className="hf-hint">No chats yet. Say hi to someone from <Link to="/providers">Find people</Link>.</p>}
            <ul className="hf-chats">
              {shownChats.map((c) => {
                const unread = c.unread_count > 0;
                const name = chatName(c);
                return (
                  <li key={c.id}>
                    <Link to={`/chat/${c.id}`} className={`hf-chat hf-fill${unread ? ' is-unread' : ''}`} data-tint={swatchFor(c.id)}>
                      <span className="hf-av">{c.is_group ? <Icon name="users" size={17} /> : initial(name)}</span>
                      <span className="hf-chat__text"><strong>{name}</strong><small>{chatPreview(c)}</small></span>
                      {unread && <b className="nb-count">{c.unread_count > 99 ? '99+' : c.unread_count}</b>}
                    </Link>
                  </li>
                );
              })}
            </ul>
            {hiddenChats > 0 && <Link to="/chat" className="hf-more"><span>+{hiddenChats} more in your inbox</span><Icon name="chevron" size={14} /></Link>}
          </section>
        </aside>

        {/* ---------- main column ---------- */}
        <div className="hf-main">
          <Section title="On the Square" to="/square" cta="Open">
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
              {statuses && rings.length === 0 && <p className="hf-hint">No statuses yet. Be the first to drop one.</p>}
            </div>
            <div className="hf-trees hf-fill" data-tint="mint">
              <span className="hf-trees__icon" aria-hidden="true"><Icon name="tree" size={18} /></span>
              <p>
                {trees == null ? 'Loading your trees…'
                  : ownTrees + taggedTrees === 0 ? 'Plant a friend tree to see your people\'s statuses.'
                    : `${ownTrees} tree${ownTrees === 1 ? '' : 's'} planted${taggedTrees ? ` · tagged in ${taggedTrees}` : ''}`}
              </p>
              <Link to="/square" className="hf-btn hf-btn--sm">{ownTrees + taggedTrees === 0 ? 'Plant one' : 'View'}</Link>
            </div>
          </Section>

          {topThoughts.length > 0 && (
            <Section title="Top thoughts" to="/square" cta="Join in">
              <div className="hf-thoughts">
                {topThoughts.map((t, i) => (
                  <Link to="/square" key={t.id} className="hf-thought hf-fill" data-tint={['coral', 'lilac', 'sky'][i % 3]}>
                    <p>{t.text.length > 120 ? `${t.text.slice(0, 120)}…` : t.text}</p>
                    <small><b>{t.user.name}</b> · {ago(t.created_at)} · <Icon name="flame" size={13} /> {t.total || 0}</small>
                  </Link>
                ))}
              </div>
            </Section>
          )}

          <Section title="Fresh plans" to="/services" cta="Browse">
            {plans && plans.length === 0 && <p className="hf-hint">No plans posted yet. <Link to="/services/mine/new">Host the first one</Link>.</p>}
            <div className="hf-plans">
              {(plans || []).slice(0, 8).map((p) => (
                <Link key={p.id} to={`/services/${p.id}`} className="hf-plan hf-fill" data-tint={lookFor(p.id, 0).tint.name}>
                  <span className="hf-plan__top">
                    <small>{p.category?.name}</small>
                    <b>{formatPrice(p.price)}</b>
                  </span>
                  <strong>{p.title}</strong>
                  <small className="hf-plan__host">Hosted by {p.provider?.username || 'someone'}</small>
                </Link>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {receipt && (
        <Modal title="Receipt" subtitle={receiptNumber(receipt)} onClose={() => setReceipt(null)}>
          <ReceiptSheet entry={receipt} who={fullName || 'You'} />
        </Modal>
      )}
    </div>
  );
}
