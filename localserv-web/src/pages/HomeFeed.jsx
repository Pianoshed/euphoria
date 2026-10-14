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
import { mediaUrl } from '../api/client';
import { formatNaira, formatPrice } from '../utils/money';
import { creditHeadline, isCredit, ledgerLabel, receiptNumber } from '../utils/ledger';
import { lookFor } from '../utils/bubbleLook';
import { usePageBackdrop } from '../hooks/usePageBackdrop';
import { useHideBalance } from '../hooks/useHideBalance';
import { Icon } from '../components/icons';
import Modal from '../components/Modal';
import { ReceiptSheet } from '../components/ReceiptNotifier';
import { ErrorAlert } from '../components/ui';
import { WALLET_LOCKED } from '../utils/walletFlags';

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

// Which notifications I have already opened, per person, kept in this browser so it survives reloads.
// An entry is "<key>|<title>": when something new happens (a 2nd message, another credit) the title changes, so it is unread again.
const readKey = (uid) => `hf-read-v1:${uid}`;
const loadRead = (uid) => {
  try {
    const all = JSON.parse(localStorage.getItem(readKey(uid)) || '{}') || {};
    return Object.fromEntries(Object.entries(all).filter(([, t]) => Date.now() - Number(t) < 14 * DAY)); // forget old marks
  } catch { return {}; }
};
const saveRead = (uid, map) => {
  try {
    const keep = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 300); // newest 300 only
    localStorage.setItem(readKey(uid), JSON.stringify(Object.fromEntries(keep)));
  } catch { /* private mode */ }
};

// Statuses already watched on the Square page (same storage key it writes), merged with the server's own flag.
const sqSeenKey = (uid) => `sq-seen-v1:${uid}`;
const readSqSeen = (uid) => { try { return JSON.parse(localStorage.getItem(sqSeenKey(uid)) || '{}') || {}; } catch { return {}; } };
const statusLabel = (s) => s.text || (s.kind === 'video' ? 'Shared a video' : s.kind === 'image' ? 'Shared a photo' : 'Shared a status');

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

/** Promo code popup: type a code, get platform credit. Credit is spent first on plans and cannot be withdrawn. */
function PromoModal({ onClose, onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const clean = code.trim();
    if (WALLET_LOCKED || busy || !clean) return;
    setBusy(true);
    setError(null);
    try {
      const res = await walletApi.redeemPromoCode(clean);
      setDone(res);
      setCode('');
      window.dispatchEvent(new Event('euphoria-wallet-changed')); // refreshes the balance and pops the receipt
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Promo code" subtitle="Enter it exactly as you got it" onClose={onClose}>
      {(close) => (done ? (
        <div className="hf-promo hf-promo--done" role="status">
          <span className="hf-ico hf-ico--lg" data-tint="mint" aria-hidden="true"><Icon name="check" size={24} /></span>
          <strong>{formatNaira(done.amount)} added</strong>
          <p>{done.name ? `${done.name}: ` : ''}it&rsquo;s in your bonus credit now. It is spent first on plans and can&rsquo;t be withdrawn.</p>
          <button type="button" className="hf-btn hf-btn--solid" onClick={close}>Done</button>
        </div>
      ) : (
        <form className="hf-promo" onSubmit={submit}>
          <span className="hf-ico hf-ico--lg" data-tint="gold" aria-hidden="true"><Icon name="gift" size={24} /></span>
          <input
            className="input hf-promo__input" placeholder="PROMO CODE" aria-label="Promo code" autoComplete="off" autoCapitalize="characters" spellCheck="false"
            maxLength={60} value={code} disabled={WALLET_LOCKED || busy} onChange={(e) => setCode(e.target.value)}
          />
          <ErrorAlert error={error} />
          {WALLET_LOCKED && <p className="hf-promo__note"><Icon name="alert" size={15} />Redeeming is switched off while the wallet is being finished.</p>}
          <button type="submit" className="hf-btn hf-btn--solid" disabled={WALLET_LOCKED || busy || !code.trim()}>{busy ? 'Checking…' : 'Redeem'}</button>
        </form>
      ))}
    </Modal>
  );
}

/** One line: icon, words, time. Opens a receipt, or goes to the right page. */
function UpdateRow({ item, onReceipt, onRead }) {
  const body = (
    <>
      <span className="hf-ico" data-tint={item.tone} aria-hidden="true"><Icon name={item.icon} size={17} /></span>
      <span className="hf-row__text"><strong>{item.title}</strong><small>{item.text}</small></span>
      <span className="hf-row__meta">
        {item.time && <time>{ago(item.time)}</time>}
        {item.hot && <i className="hf-pip" aria-label="Unread" />}
      </span>
    </>
  );
  const cls = `hf-row ${item.hot ? 'is-hot' : 'is-read'}`;
  return item.receipt
    ? <button type="button" className={cls} onClick={() => { onRead(item.sig); onReceipt(item.receipt); }}>{body}</button>
    : <Link to={item.to} className={cls} onClick={() => onRead(item.sig)}>{body}</Link>;
}

export default function HomeFeed() {
  usePageBackdrop('scene');
  const { user } = useAuth();
  const alerts = useAlerts();
  const { hidden: balHidden, toggle: toggleBal, naira } = useHideBalance();
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
  const [readMap, setReadMap] = useState(() => loadRead(uid));
  const [drawer, setDrawer] = useState(null);         // 'updates' | 'explore' | null
  const [receipt, setReceipt] = useState(null);
  const [promoOpen, setPromoOpen] = useState(false);
  const [sqSeen, setSqSeen] = useState(() => readSqSeen(uid));
  const [avatarFailed, setAvatarFailed] = useState(false);

  // plans do not need to feel live
  useEffect(() => {
    let off = false;
    servicesApi.listServices({}).then((d) => { if (!off) setPlans(rows(d)); }).catch(() => { if (!off) setPlans([]); });
    return () => { off = true; };
  }, []);

  // what is happening: chats, plans, wallet. Refreshed on focus, every 45s, when counts change, and when the wallet changes.
  const loadPulse = useCallback(async () => {
    const safe = (p) => p.catch(() => null);
    const [conv, own, host, led, bal, pb, pc, st, th, tr] = await Promise.all([
      safe(chatApi.listConversations()),
      safe(bookingsApi.listBookings({ role: 'customer' })),
      safe(bookingsApi.listBookings({ role: 'provider' })),
      safe(walletApi.getLedger()),
      safe(walletApi.getBalance()),
      safe(walletApi.getPromotionalBalance()),
      safe(walletApi.listPromotionalCredits()),
      safe(squareApi.listStatuses()),
      safe(squareApi.listThoughts()),
      safe(squareApi.listTrees()),
    ]);
    if (st) setStatuses(rows(st));
    if (th) setThoughts(rows(th));
    if (tr) setTrees(rows(tr));
    setSqSeen(readSqSeen(uid));
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
  }, [uid]);

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
  useEffect(() => { setReadMap(loadRead(uid)); }, [uid]);
  const markRead = useCallback((...sigs) => {
    setReadMap((prev) => {
      const next = { ...prev };
      sigs.flat().forEach((g) => { if (g) next[g] = Date.now(); });
      saveRead(uid, next);
      return next;
    });
  }, [uid]);

  // ---------- derived ----------
  const unreadChats = (chats || []).filter((c) => c.unread_count > 0);
  const shownChats = (chats || []).slice(0, CHAT_LIMIT);
  const hiddenChats = Math.max(0, (chats || []).length - shownChats.length);
  const chatName = (c) => (c.is_group ? (c.title || 'Group chat') : (names[c.other_user_id] || '…'));
  const chatPreview = (c) => {
    const last = c.last_message;
    return last ? (last.body === null ? 'Message deleted' : last.body || (last.attachment_type === 'audio' ? 'Voice message' : 'Photo')) : 'Nothing yet. Say hi.';
  };

  // Same credit twice (e.g. a refund written as two ledger rows, or the same top-up amount again) = ONE notification with a count.
  const recentCredits = useMemo(() => {
    const groups = new Map(); // ledger is newest first, so the first of each kind is the newest
    ledger.filter((e) => Date.now() - stamp(e.created_at) < 7 * DAY).forEach((e) => {
      const k = `${creditHeadline(e.entry_type)[1]}|${num(e.amount)}|${e.note || ''}`;
      const g = groups.get(k);
      if (g) g.count += 1; else groups.set(k, { ...e, count: 1 });
    });
    return [...groups.values()].slice(0, 5);
  }, [ledger]);
  const expiring = useMemo(() => promoCredits.filter((c) => num(c.remaining_amount) > 0 && c.expires_at && daysLeft(c.expires_at) <= 7), [promoCredits]);
  const bonus = promo ? num(promo.promotional_balance) : null;
  const nextPlan = mine[0] || null;
  // Square: only people inside one of my friend trees (tree owners and tagged members), exactly like the Square page.
  const friends = useMemo(() => {
    const map = new Map(); // id -> title of the tree that connects us
    (trees || []).forEach((t) => {
      [t.owner, ...(t.members || [])].forEach((p) => { if (p && String(p.id) !== String(uid) && !map.has(String(p.id))) map.set(String(p.id), t.title || 'a tree'); });
    });
    return map;
  }, [trees, uid]);
  const friendStatuses = useMemo(
    () => (statuses || []).filter((x) => friends.has(String(x.user.id)))
      .sort((a, b) => stamp(b.created_at) - stamp(a.created_at)),
    [statuses, friends],
  );
  const isSeen = (x) => Boolean(x.seen || sqSeen[x.id]);
  const unseenFriendStatuses = friendStatuses.filter((x) => !isSeen(x));
  const unseenFriendPeople = [...new Map(unseenFriendStatuses.map((x) => [String(x.user.id), x.user.name])).values()];
  const friendThoughts = useMemo(
    () => (thoughts || []).filter((t) => t.user && friends.has(String(t.user.id)) && Date.now() - stamp(t.created_at) < DAY)
      .sort((a, b) => stamp(b.created_at) - stamp(a.created_at)).slice(0, 2),
    [thoughts, friends],
  );

  // every notification, in one list: money first, then people who need an answer, then the rest
  const updates = useMemo(() => {
    const items = [];
    recentCredits.forEach((e) => {
      const [icon, title] = creditHeadline(e.entry_type);
      const at = stamp(e.created_at);
      items.push({
        key: `w${e.id}`, rank: 0, icon, tone: 'mint', hot: true, receipt: e, at,
        title: `${title} +${formatNaira(e.amount)}${e.count > 1 ? ` ×${e.count}` : ''}`, text: `${e.note || ledgerLabel(e.entry_type)} · View receipt`, time: e.created_at,
      });
    });
    if (expiring.length) {
      const total = expiring.reduce((s, c) => s + num(c.remaining_amount), 0);
      const soonest = Math.min(...expiring.map((c) => daysLeft(c.expires_at)));
      items.push({
        key: 'expiring', rank: 1, live: true, icon: 'clock', tone: 'gold', hot: true, to: '/wallet', at: Date.now(),
        title: `${formatNaira(total)} bonus expiring`, text: soonest <= 0 ? 'Use it today on a plan' : `Use it within ${plural(soonest, 'day', 'days')} on a plan`, time: null,
      });
    }
    hosting.slice(0, 2).forEach((b) => items.push({
      key: `h${b.id}`, rank: 1, live: true, icon: 'hand', tone: 'gold', hot: true, to: `/bookings/${b.id}`, at: stamp(b.created_at),
      title: `${b.customer?.username || b.customer_username || 'Someone'} wants to join`, text: b.service_title, time: b.created_at,
    }));
    const hostingIds = new Set(hosting.slice(0, 2).map((b) => String(b.id)));
    mine.filter((b) => !hostingIds.has(String(b.id))).forEach((b) => {
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
        key: 'msgs', rank: 3, live: true, icon: 'chat', tone: 'lilac', hot: true, at: stamp(unreadChats[0]?.last_message?.created_at),
        to: unreadChats.length === 1 ? `/chat/${unreadChats[0].id}` : '/chat',
        title: plural(alerts.messages, 'new message', 'new messages'), text: who ? `From ${who}` : 'Tap to read', time: unreadChats[0]?.last_message?.created_at,
      });
    }
    if (alerts.missedCalls > 0) {
      items.push({ key: 'calls', rank: 4, live: true, icon: 'phone', tone: 'coral', hot: true, to: '/calls', at: 0, title: plural(alerts.missedCalls, 'missed call', 'missed calls'), text: 'Since you last looked', time: null });
    }
    if (unseenFriendPeople.length > 0) {
      const names3 = unseenFriendPeople.slice(0, 2).join(' & ');
      const more = unseenFriendPeople.length - 2;
      items.push({
        key: 'sq-group', rank: 3, live: true, icon: 'tree', tone: 'sky', hot: true, to: '/square', at: stamp(unseenFriendStatuses[0]?.created_at),
        title: `${plural(unseenFriendPeople.length, 'friend', 'friends')} posted a status`,
        text: `${names3}${more > 0 ? ` and ${more} more` : ''} on your trees`, time: unseenFriendStatuses[0]?.created_at,
      });
    }
    // the full Square feed lives in the drawer: one row per friend status, then friends' thoughts
    const onePerFriend = new Map();
    friendStatuses.filter(isSeen).forEach((x) => { if (!onePerFriend.has(String(x.user.id))) onePerFriend.set(String(x.user.id), x); });
    [...onePerFriend.values()].slice(0, 6).forEach((x) => items.push({
      key: `sq-s${x.id}`, rank: 7, drawerOnly: true, icon: x.kind === 'video' ? 'film' : x.kind === 'image' ? 'image' : 'tree', tone: 'sky',
      hot: false, to: '/square', at: stamp(x.created_at),
      title: `${x.user.name} posted a status`, text: `${statusLabel(x)} · ${friends.get(String(x.user.id))}`, time: x.created_at,
    }));
    friendThoughts.forEach((t) => items.push({
      key: `sq-t${t.id}`, rank: 8, drawerOnly: true, icon: 'thought', tone: 'lilac', hot: true, to: '/square', at: stamp(t.created_at),
      title: `${t.user.name} shared a thought`, text: t.text, time: t.created_at,
    }));
    // unread = needs attention AND I have not opened it yet (remembered in this browser)
    const weekAgo = Date.now() - 7 * DAY;
    return items
      .filter((u) => !(u.at > 0) || u.at >= weekAgo) // undated rows (missed calls, expiring bonus) stay; dated ones go after a week
      .map((u) => { const sig = `${u.key}|${u.title}`; return { ...u, sig, hot: u.hot && (u.live || !readMap[sig]) }; })
      .sort((a, b) => Number(b.hot) - Number(a.hot) || a.rank - b.rank || b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readMap, recentCredits, expiring, hosting, mine, alerts.messages, alerts.missedCalls, unreadChats.length, names, friendStatuses, friendThoughts, friends, unseenFriendPeople.length, sqSeen]);

  const needsYou = updates.filter((u) => u.hot && !u.drawerOnly);
  const readItems = updates.filter((u) => !u.hot && !u.drawerOnly);
  const topNeeds = [...needsYou.slice(0, 3), ...readItems].slice(0, 4); // unread first (crimson), then ones already read (plain)
  const markable = updates.some((u) => u.hot && !u.live);
  const hotCount = needsYou.length;

  const lead = alerts.messages > 0 ? `${plural(alerts.messages, 'message is', 'messages are')} waiting for you.`
    : alerts.missedCalls > 0 ? `You missed ${plural(alerts.missedCalls, 'call', 'calls')}.`
      : nextPlan ? `${nextPlan.service_title} ${BOOKING_COPY[nextPlan.status].text}.`
        : 'Nothing urgent right now.';

  const closeDrawer = () => {
    setDrawer(null);
  };

  const avatar = user?.avatar && !avatarFailed
    ? <img className="hf-me__img" src={mediaUrl(user.avatar)} alt="" onError={() => setAvatarFailed(true)} />
    : <span className="hf-me__img" aria-hidden="true">{initial(fullName)}</span>;

  const rings = useMemo(() => {
    const seen = new Set();
    return friendStatuses.filter((x) => (seen.has(x.user.id) ? false : seen.add(x.user.id)))
      .sort((a, b) => Number(isSeen(a)) - Number(isSeen(b))).slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendStatuses, sqSeen]);
  const myStatus = (statuses || []).some((x) => x.user.id === uid);
  const ownTrees = (trees || []).filter((t) => t.mine).length;
  const taggedTrees = (trees || []).length - ownTrees;
  const topThoughts = [...(thoughts || [])].filter((t) => t.user && (String(t.user.id) === String(uid) || friends.has(String(t.user.id)))).sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 3);

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
                <button type="button" className="hf-eye" onClick={toggleBal} aria-pressed={balHidden}
                  aria-label={balHidden ? 'Show wallet balance' : 'Hide wallet balance'}>
                  <Icon name={balHidden ? 'eyeOff' : 'eye'} size={17} />
                </button>
                <Link to="/wallet" className="hf-link">Open<Icon name="chevron" size={14} /></Link>
              </div>
              <p className="hf-wallet__amount">{balance == null ? '–' : naira(balance)}</p>
              {bonus > 0 && (
                <p className="hf-wallet__bonus">
                  <Icon name="gift" size={15} />
                  <span><b>{naira(bonus)}</b> bonus credit<small> · spent first on plans, not withdrawable</small></span>
                </p>
              )}
              <div className="hf-wallet__acts">
                <Link to="/wallet" className="hf-btn hf-btn--solid"><Icon name="plus" size={16} />Add money</Link>
                <button type="button" className="hf-btn" onClick={() => setPromoOpen(true)}><Icon name="gift" size={16} />Promo code</button>
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
              {topNeeds.length > 0 && hotCount === 0 && <p className="hf-hint"><Icon name="check" size={15} />You&rsquo;re all caught up.</p>}
              {topNeeds.length > 0
                ? <div className="hf-list">{topNeeds.map((u) => <UpdateRow key={u.key} item={u} onReceipt={setReceipt} onRead={markRead} />)}</div>
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
          {markable && (
            <button type="button" className="hf-markall" onClick={() => markRead(updates.filter((u) => !u.live).map((u) => u.sig))}>Mark all as read</button>
          )}
          <div className="hf-list">{updates.map((u) => <UpdateRow key={u.key} item={u} onReceipt={setReceipt} onRead={markRead} />)}</div>

          <h3 className="hf-drawer__sub">Your money</h3>
          <dl className="hf-money">
            <div><dt>Wallet balance</dt><dd>{balance == null ? '–' : naira(balance)}</dd></div>
            <div><dt>Bonus credit</dt><dd>{bonus == null ? '–' : naira(bonus)}</dd></div>
          </dl>
          <button type="button" className="hf-row hf-row--flat" onClick={() => setPromoOpen(true)}>
            <span className="hf-ico" data-tint="gold" aria-hidden="true"><Icon name="gift" size={17} /></span>
            <span className="hf-row__text"><strong>Have a promo code?</strong><small>Redeem it for bonus credit</small></span>
            <Icon name="chevron" size={16} />
          </button>
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
              <Link key={s.user.id} to="/square" className={`hf-ring${isSeen(s) ? ' is-seen' : ''}`}>
                <span className="hf-ring__o"><span className="hf-ring__i">{initial(s.user.name)}</span></span>
                <small>{s.user.name}</small>
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

      {promoOpen && <PromoModal onClose={() => setPromoOpen(false)} onDone={loadPulse} />}

      {receipt && (
        <Modal title="Receipt" subtitle={receiptNumber(receipt)} onClose={() => setReceipt(null)}>
          <ReceiptSheet entry={receipt} who={fullName || 'You'} />
        </Modal>
      )}
    </div>
  );
}
