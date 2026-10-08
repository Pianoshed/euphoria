import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PeoplePicker from '../../components/PeoplePicker';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../api/square';
import { shrinkImage, shrinkVideo, MAX_VIDEO_SECONDS } from './shrinkMedia';
import { treeBlob, treeFileName } from './treeImage';
import { CIRCLES, SHARED, circleMeta, labelFor, saveLocalLabels } from './circles';
import './square.css';

const EMOJI = ['🔥', '😂', '❤️', '😮', '👏'];
const POLL_MS = 20000;
const hoursLeft = (iso) => Math.max(1, Math.ceil((new Date(iso) - Date.now()) / 36e5));
const ago = (iso) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const initial = (name) => (name || '?').charAt(0).toUpperCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ---------- who counts as "my people" ---------- */
// Statuses are only ever shown for people inside one of my friend trees (me, tree owners, tagged members).
const friendSet = (trees, me) => {
  const ids = new Set();
  if (me) ids.add(String(me.id));
  trees.forEach((t) => { ids.add(String(t.owner.id)); t.members.forEach((m) => ids.add(String(m.id))); });
  return ids;
};
// How *I* know each person: my own trees' labels win; people who only reach me through someone else's tree are "shared".
const labelMap = (trees, me) => {
  const lab = {};
  trees.filter((t) => t.mine).forEach((t) => t.members.forEach((m) => { if (!lab[m.id]) lab[m.id] = labelFor(t, m); }));
  trees.filter((t) => !t.mine).forEach((t) => [t.owner, ...t.members].forEach((p) => { if (!lab[p.id]) lab[p.id] = 'shared'; }));
  if (me) delete lab[me.id];
  return lab;
};

// Random but stable: the order only changes when the seed changes (Shuffle button / page load), not on every poll.
const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const shuffled = (list, seed) => [...list].sort((a, b) => hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`));

/* ---------- scroll lock + escape handling shared by every layer ---------- */
let locks = 0;
const lock = () => { if (locks++ === 0) document.body.style.overflow = 'hidden'; };
const unlock = () => { if (--locks <= 0) { locks = 0; document.body.style.overflow = ''; } };
const layers = []; // Escape only closes the top-most modal

function Pill({ circle, count }) {
  return (
    <span className="sq-pill" style={{ '--c': circle.color }}>
      <span aria-hidden="true">{circle.emoji}</span>{circle.label}{count != null && <b>{count}</b>}
    </span>
  );
}

function Reactions({ mine, counts, onPick }) {
  return (
    <div className="sq-reacts">
      {EMOJI.map((e) => (
        <button key={e} type="button" className={`sq-rx${mine === e ? ' sq-rx--me' : ''}`}
          aria-pressed={mine === e} onClick={() => onPick(e)}>
          {e} {counts?.[e] ?? ''}
        </button>
      ))}
    </div>
  );
}

// Shared modal shell: backdrop click, Escape (top layer only), scroll lock, enter + exit animation.
function Overlay({ onClose, label, sheet, children }) {
  const [leaving, setLeaving] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef(null);
  const close = useCallback(() => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = setTimeout(() => onCloseRef.current(), 180);
  }, []);
  useEffect(() => {
    const me = {};
    layers.push(me);
    const key = (e) => { if (e.key === 'Escape' && layers[layers.length - 1] === me) close(); };
    window.addEventListener('keydown', key);
    lock();
    return () => {
      window.removeEventListener('keydown', key);
      layers.splice(layers.indexOf(me), 1);
      unlock();
      clearTimeout(timer.current);
    };
  }, [close]);
  return (
    <div className={`sq-viewer${sheet ? ' sq-viewer--sheet' : ''}${leaving ? ' is-leaving' : ''}`}
      role="dialog" aria-modal="true" aria-label={label}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {children(close)}
    </div>
  );
}

/* ---------- status viewer (tap right = next, left = back, auto-advances) ---------- */
function ViewerBody({ status, circle, close, onReact, onPrev, onNext }) {
  const isVideo = status.kind === 'video';
  const ms = isVideo ? Math.min(status.duration || MAX_VIDEO_SECONDS, MAX_VIDEO_SECONDS) * 1000 : 6000;
  const advance = useRef();
  advance.current = () => (onNext ? onNext() : close());
  useEffect(() => {
    const t = setTimeout(() => advance.current(), ms + 300);
    return () => clearTimeout(t);
  }, [status.id, ms]);
  return (
    <div className="sq-stage">
      <div className="sq-bar"><span key={status.id} style={{ animationDuration: `${ms}ms` }} /></div>
      <div className="sq-vhead">
        <div className="sq-vwho">
          <span className="sq-av sq-av--sm">{initial(status.user.name)}</span>
          <div className="sq-vname">
            <b>{status.user.name}</b>
            <small>{circle ? `${circle.emoji} ${circle.label} · ` : ''}{hoursLeft(status.expires_at)}h left</small>
          </div>
        </div>
        <button type="button" className="sq-x" onClick={close} aria-label="Close">✕</button>
      </div>
      {status.kind === 'image' && <img src={status.file} alt="" />}
      {isVideo && <video src={status.file} autoPlay playsInline controls={false} onEnded={() => advance.current()} />}
      {status.kind === 'text' && <p className="sq-big">{status.text}</p>}
      {status.kind !== 'text' && status.text && <p className="sq-cap">{status.text}</p>}
      {onPrev && <button type="button" className="sq-tap sq-tap--l" aria-label="Previous status" onClick={onPrev} />}
      <button type="button" className="sq-tap sq-tap--r" aria-label={onNext ? 'Next status' : 'Close'} onClick={() => advance.current()} />
      <div className="sq-vfoot"><Reactions mine={status.my_reaction} onPick={(e) => onReact(status, e)} /></div>
    </div>
  );
}

function Viewer({ status, circle, onClose, onReact, onPrev, onNext }) {
  return (
    <Overlay label={`${status.user.name}'s status`} onClose={onClose}>
      {(close) => <ViewerBody key={status.id} status={status} circle={circle} close={close} onReact={onReact} onPrev={onPrev} onNext={onNext} />}
    </Overlay>
  );
}

function ConfirmDialog({ title, body, okLabel = 'Confirm', danger, onOk, onClose }) {
  return (
    <Overlay sheet label={title} onClose={onClose}>
      {(close) => (
        <div className="sq-sheet sq-sheet--confirm">
          <span className="sq-grab" aria-hidden="true" />
          <h2>{title}</h2>
          <p className="sq-hint">{body}</p>
          <div className="sq-row">
            <button type="button" className="sq-ghost" onClick={close}>Cancel</button>
            <button type="button" className={`sq-cta${danger ? ' sq-cta--danger' : ''}`}
              onClick={() => { close(); setTimeout(onOk, 190); }}>{okLabel}</button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

/* ---------- friend trees ---------- */
function Bubble({ person, color, big, live, onClick }) {
  return (
    <button type="button" className={`sq-bub${big ? ' sq-bub--big' : ''}${live ? ' sq-bub--live' : ''}`}
      style={color ? { '--c': color } : undefined} onClick={onClick} aria-label={`${person.name}${live ? ', has a status' : ''}`}>
      <i>{initial(person.name)}</i>
      <small>{person.name}</small>
    </button>
  );
}

// Compact row in the list; tap to open the full tree in a sheet.
function TreeCard({ tree, onOpen }) {
  const counts = useMemo(() => {
    const c = {};
    if (tree.mine) tree.members.forEach((m) => { const k = labelFor(tree, m); c[k] = (c[k] || 0) + 1; });
    return CIRCLES.filter((x) => c[x.key]).map((x) => ({ circle: x, n: c[x.key] }));
  }, [tree]);
  const faces = tree.members.slice(0, 4);
  return (
    <button type="button" className="sq-card sq-tcard" onClick={() => onOpen(tree)}>
      <span className="sq-stack" aria-hidden="true">
        {faces.map((m, i) => (
          <i key={m.id} style={{ '--c': tree.mine ? circleMeta(labelFor(tree, m)).color : 'var(--color-violet)', zIndex: 5 - i }}>{initial(m.name)}</i>
        ))}
        {tree.members.length > 4 && <i className="sq-stack__more">+{tree.members.length - 4}</i>}
      </span>
      <span className="sq-tcard__info">
        <b>{tree.title}</b>
        <small>{plural(tree.members.length, 'person', 'people')}{tree.mine ? '' : ` · by ${tree.owner.name}`}</small>
        {counts.length > 0 && <span className="sq-pills">{counts.map(({ circle, n }) => <Pill key={circle.key} circle={circle} count={n} />)}</span>}
      </span>
      <span className="sq-chev" aria-hidden="true">›</span>
    </button>
  );
}

function TreeSheet({ tree, statusByUser, onClose, onLeave, onStatus, onMember, pop, ask }) {
  const [busy, setBusy] = useState('');
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

  // Branches by label on my own trees; one plain branch on trees I was tagged in (those labels are the owner's view).
  const groups = useMemo(() => {
    if (!tree.mine) return [{ key: 'in', label: 'In this tree', emoji: '🌳', color: 'var(--color-violet)', people: tree.members }];
    return CIRCLES.map((c) => ({ ...c, people: tree.members.filter((m) => labelFor(tree, m) === c.key) })).filter((g) => g.people.length);
  }, [tree]);

  const download = async () => {
    try {
      const url = URL.createObjectURL(await treeBlob(tree));
      const a = document.createElement('a');
      a.href = url; a.download = treeFileName(tree); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { pop('Could not make the image'); }
  };
  const share = async () => {
    try {
      const file = new File([await treeBlob(tree)], treeFileName(tree), { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: tree.title });
      else await navigator.share({ title: tree.title, text: `${tree.title} on Euphoria` });
    } catch (e) { if (e?.name !== 'AbortError') pop('Could not share'); }
  };
  const postStatus = async () => {
    setBusy('Posting…');
    try {
      const file = new File([await treeBlob(tree)], 'tree.png', { type: 'image/png' });
      const fd = new FormData();
      fd.append('text', tree.title.slice(0, 140));
      fd.append('file', await shrinkImage(file), 'status.jpg');
      onStatus(await api.createStatus(fd));
      pop('Posted to your status');
    } catch (e) { pop(e.body?.detail || 'Could not post'); }
    setBusy('');
  };
  const asStatus = () => ask({
    title: 'Post this tree as a status?',
    body: 'Only people in your friend trees will see it, for 24 hours.',
    okLabel: 'Post it',
    onOk: postStatus,
  });

  return (
    <Overlay sheet label={tree.title} onClose={onClose}>
      {(close) => (
        <div className="sq-sheet sq-sheet--tall">
          <span className="sq-grab" aria-hidden="true" />
          <header className="sq-sheet__head">
            <div>
              <h2>{tree.title}</h2>
              <small>{plural(tree.members.length, 'person', 'people')}</small>
            </div>
            <button type="button" className="sq-x sq-x--soft" onClick={close} aria-label="Close">✕</button>
          </header>
          {tree.note && <p className="sq-hint">{tree.note}</p>}
          <div className="sq-tree">
            <Bubble person={tree.owner} big live={!!statusByUser[tree.owner.id]} onClick={() => onMember(tree.owner)} />
            <span className="sq-trunk" aria-hidden="true" />
            {groups.map((g) => (
              <section key={g.key} className="sq-branch" style={{ '--c': g.color }}>
                <h4><span aria-hidden="true">{g.emoji}</span>{g.label}<b>{g.people.length}</b></h4>
                <div className="sq-bubs">
                  {g.people.map((m) => <Bubble key={m.id} person={m} color={g.color} live={!!statusByUser[m.id]} onClick={() => onMember(m)} />)}
                </div>
              </section>
            ))}
            {tree.members.length === 0 && <p className="sq-hint">Nobody here yet.</p>}
          </div>
          {tree.mine && <p className="sq-hint sq-center">Tap anyone to change how you know them.</p>}
          <div className="sq-acts">
            <button type="button" className="sq-ghost" onClick={download}>⬇ Image</button>
            {canShare && <button type="button" className="sq-ghost" onClick={share}>↗ Share</button>}
            <button type="button" className="sq-ghost" disabled={!!busy} onClick={asStatus}>{busy || '✨ Post as status'}</button>
            <button type="button" className="sq-ghost sq-ghost--danger" onClick={() => onLeave(tree)}>{tree.mine ? '🗑 Delete tree' : '👋 Leave tree'}</button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

function MemberSheet({ tree, person, status, canEdit, onLabel, onStatus, onClose }) {
  const isOwner = String(tree.owner.id) === String(person.id);
  const current = !isOwner && tree.mine ? labelFor(tree, person) : null;
  return (
    <Overlay sheet label={person.name} onClose={onClose}>
      {(close) => (
        <div className="sq-sheet sq-sheet--member">
          <span className="sq-grab" aria-hidden="true" />
          <div className="sq-mhead">
            <span className={`sq-av sq-av--lg${status ? ' sq-av--live' : ''}`}>{initial(person.name)}</span>
            <div>
              <h2>{person.name}</h2>
              <small>{isOwner ? `Owner of ${tree.title}` : `In ${tree.title}`}</small>
              {current && <Pill circle={circleMeta(current)} />}
            </div>
          </div>
          {canEdit && !isOwner && (
            <>
              <h3 className="sq-sec">How do you know them?</h3>
              <div className="sq-picks" role="radiogroup" aria-label={`How do you know ${person.name}?`}>
                {CIRCLES.map((c) => (
                  <button key={c.key} type="button" role="radio" aria-checked={current === c.key}
                    className={`sq-pick${current === c.key ? ' is-on' : ''}`} style={{ '--c': c.color }}
                    onClick={() => onLabel(tree, person, c.key)}>
                    <span aria-hidden="true">{c.emoji}</span>{c.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="sq-row">
            {status && <button type="button" className="sq-cta" onClick={() => onStatus(status)}>▶ View status</button>}
            <Link to={`/profile/${person.id}`} className="sq-ghost sq-ghost--link">View profile</Link>
          </div>
          <button type="button" className="sq-link" onClick={close}>Done</button>
        </div>
      )}
    </Overlay>
  );
}

/* ---------- composers ---------- */
function ThoughtSheet({ onClose, onPosted }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const t = setTimeout(() => ref.current?.focus({ preventScroll: true }), 300); return () => clearTimeout(t); }, []);
  const submit = async (close) => {
    setErr(''); setBusy(true);
    try { onPosted(await api.createThought(text.trim())); close(); }
    catch (e) { setErr(e.body?.text?.[0] || e.body?.detail || 'Could not post.'); setBusy(false); }
  };
  return (
    <Overlay sheet label="Share a thought" onClose={onClose}>
      {(close) => (
        <div className="sq-sheet">
          <span className="sq-grab" aria-hidden="true" />
          <h2>What's on your mind?</h2>
          <div className="sq-field">
            <textarea ref={ref} rows={4} maxLength={280} placeholder="Share a thought with the Square…" value={text}
              aria-label="Share a thought" onChange={(e) => setText(e.target.value)} />
            <small className="sq-counter">{text.length}/280</small>
          </div>
          {err && <p className="sq-err" role="alert">{err}</p>}
          <div className="sq-row">
            <button type="button" className="sq-ghost" disabled={busy} onClick={close}>Cancel</button>
            <button type="button" className="sq-cta" disabled={busy || !text.trim()} onClick={() => submit(close)}>{busy ? 'Sharing…' : 'Share thought'}</button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

function Composer({ onClose, onPosted }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const isImg = file?.type.startsWith('image/');
  const isVid = file?.type.startsWith('video/');

  const submit = async (close) => {
    setErr('');
    if (!file && !text.trim()) return setErr('Add a photo, a video or some text.');
    try {
      const fd = new FormData();
      fd.append('text', text.trim());
      if (isImg) {
        setBusy('Shrinking photo…');
        fd.append('file', await shrinkImage(file), 'status.jpg');
      } else if (isVid) {
        setBusy(`Trimming video (up to ${MAX_VIDEO_SECONDS}s)…`);
        const { blob, duration } = await shrinkVideo(file);
        fd.append('file', blob, 'status.webm');
        fd.append('duration', String(duration));
      } else if (file) return setErr('Choose a photo or a video.');
      setBusy('Posting…');
      onPosted(await api.createStatus(fd));
      close();
    } catch (e) {
      setErr(e.body?.file?.[0] || e.body?.detail || e.message || 'Could not post. Try again.');
      setBusy('');
    }
  };
  return (
    <Overlay sheet label="New status" onClose={onClose}>
      {(close) => (
        <div className="sq-sheet">
          <span className="sq-grab" aria-hidden="true" />
          <h2>New status</h2>
          <div className="sq-field">
            <input type="text" maxLength={140} placeholder="Say something (optional)" value={text}
              onChange={(e) => setText(e.target.value)} />
            <small className="sq-counter">{text.length}/140</small>
          </div>
          {preview ? (
            <div className="sq-preview">
              {isImg && <img src={preview} alt="Selected" />}
              {isVid && <video src={preview} muted playsInline />}
              {!isImg && !isVid && <p className="sq-hint">Unsupported file</p>}
              <button type="button" className="sq-x sq-x--dark" aria-label="Remove file" onClick={() => setFile(null)}>✕</button>
            </div>
          ) : (
            <label className="sq-drop">
              <span aria-hidden="true">📷</span>
              <b>Add a photo or video</b>
              <small>Tap to choose from your phone</small>
              <input type="file" accept="image/*,video/*" onChange={(e) => setFile(e.target.files[0] || null)} />
            </label>
          )}
          <p className="sq-hint">Only people in your friend trees will see it. Photos are shrunk, videos cut to {MAX_VIDEO_SECONDS}s, and it disappears after 24 hours.</p>
          {err && <p className="sq-err" role="alert">{err}</p>}
          <div className="sq-row">
            <button type="button" className="sq-ghost" disabled={!!busy} onClick={close}>Cancel</button>
            <button type="button" className="sq-cta" disabled={!!busy} onClick={() => submit(close)}>{busy || 'Post for 24 hours'}</button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

/* ---------- side drawers: slide-in on phones, plain sidebars on desktop ---------- */
function Drawer({ side, title, open, onClose, children }) {
  const x0 = useRef(null);
  return (
    <aside className={`sq-drawer sq-drawer--${side}${open ? ' is-open' : ''}`} aria-label={title}
      onTouchStart={(e) => { x0.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (x0.current == null) return;
        const dx = e.changedTouches[0].clientX - x0.current;
        x0.current = null;
        if ((side === 'left' && dx < -60) || (side === 'right' && dx > 60)) onClose(); // swipe it away
      }}>
      <header className="sq-drawer__head">
        <h2>{title}</h2>
        <button type="button" className="sq-x sq-x--soft" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
      </header>
      {children}
    </aside>
  );
}

export default function Square() {
  const { user } = useAuth();
  const [statuses, setStatuses] = useState([]);
  const [thoughts, setThoughts] = useState([]);
  const [trending, setTrending] = useState({ statuses: [], thoughts: [], emoji: [] });
  const [trees, setTrees] = useState([]);
  const [sort, setSort] = useState('new');
  const [tab, setTab] = useState('thoughts');
  const [filter, setFilter] = useState('all');
  const [seed, setSeed] = useState(() => Math.random().toString(36).slice(2));
  const [drawer, setDrawer] = useState(null); // 'left' | 'right' | null
  const [dial, setDial] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [composing, setComposing] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [sheetId, setSheetId] = useState(null);
  const [member, setMember] = useState(null);
  const [seen, setSeen] = useState({});
  const [pops, setPops] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const prev = useRef(null);
  const friendRef = useRef(new Set());

  const pop = useCallback((msg, status) => {
    const id = Math.random();
    setPops((p) => [...p.slice(-2), { id, msg, status }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 4500);
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, t, tr, tt] = await Promise.all([
        api.listStatuses(), api.listThoughts(), api.getTrending(), api.listTrees().catch(() => null),
      ]);
      if (tt) { setTrees(tt); friendRef.current = friendSet(tt, user); }
      const p = prev.current;
      if (p && user) {
        s.forEach((x) => {
          const old = p.s.find((y) => y.id === x.id);
          if (!old && x.user.id !== user.id && friendRef.current.has(String(x.user.id))) pop(`${x.user.name} posted a status`, x);
          else if (old && x.user.id === user.id && x.likes > old.likes) pop('Someone reacted to your status');
        });
        t.forEach((x) => { if (!p.t.some((y) => y.id === x.id) && x.user.id !== user.id) pop(`${x.user.name} shared a thought`); });
      }
      prev.current = { s, t };
      setStatuses(s); setThoughts(t); setTrending(tr);
    } catch { /* keep what is on screen; the next poll retries */ }
    setLoaded(true);
  }, [user, pop]);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // drawers: scroll lock + Escape
  useEffect(() => {
    if (!drawer) return undefined;
    lock();
    const key = (e) => { if (e.key === 'Escape' && layers.length === 0) setDrawer(null); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); unlock(); };
  }, [drawer]);

  /* ----- derived: my people, their circles, the random friends-only stories ----- */
  const friendIds = useMemo(() => friendSet(trees, user), [trees, user]);
  const labelOf = useMemo(() => labelMap(trees, user), [trees, user]);
  const counts = useMemo(() => {
    const c = {};
    Object.values(labelOf).forEach((k) => { c[k] = (c[k] || 0) + 1; });
    return c;
  }, [labelOf]);
  const circles = useMemo(() => [...CIRCLES, SHARED].filter((c) => counts[c.key]), [counts]);
  const active = filter === 'all' || counts[filter] ? filter : 'all';
  const people = Math.max(0, friendIds.size - 1);

  const visible = useMemo(() => statuses.filter((s) => friendIds.has(String(s.user.id))), [statuses, friendIds]);
  const stories = useMemo(() => {
    const list = visible.filter((s) => s.user.id === user?.id || active === 'all' || labelOf[s.user.id] === active);
    return [...list.filter((s) => s.user.id === user?.id), ...shuffled(list.filter((s) => s.user.id !== user?.id), seed)];
  }, [visible, active, labelOf, seed, user]);
  const statusByUser = useMemo(() => {
    const m = {};
    visible.forEach((s) => { if (!m[s.user.id]) m[s.user.id] = s; });
    return m;
  }, [visible]);
  const trendingStatuses = trending.statuses.filter((s) => friendIds.has(String(s.user.id)));

  const treesShown = trees.filter((t) => active === 'all'
    || (active === 'shared' ? !t.mine : t.mine && t.members.some((m) => labelFor(t, m) === active)));
  const shown = sort === 'top' ? [...thoughts].sort((a, b) => b.total - a.total) : thoughts;
  const sheetTree = trees.find((t) => t.id === sheetId);

  /* ----- actions ----- */
  const swap = (setList) => (item) => setList((cur) => cur.map((x) => (x.id === item.id ? item : x)));
  const open = (s) => { setSeen((x) => ({ ...x, [s.id]: true })); setViewing(s); setDrawer(null); };
  const reactStatus = async (s, emoji) => {
    try { const u = await api.reactStatus(s.id, emoji); swap(setStatuses)(u); setViewing((v) => (v?.id === u.id ? u : v)); load(); } catch { pop('Could not send that reaction'); }
  };
  const reactThought = async (t, emoji) => {
    try { swap(setThoughts)(await api.reactThought(t.id, emoji)); load(); } catch { pop('Could not send that reaction'); }
  };
  const makeTree = async (ids, title, labels) => {
    if (!title) throw new Error('Give your tree a name.');
    const t = await api.createTree(title, ids, '', labels);
    if (labels) saveLocalLabels(t.id, labels);
    setTrees((cur) => [t, ...cur]);
    setTreeOpen(false); setTab('trees');
    pop(`🌳 "${title}" planted`);
  };
  const setLabel = async (t, person, key) => {
    const labels = { ...Object.fromEntries(t.members.map((m) => [m.id, labelFor(t, m)])), [person.id]: key };
    let saved = true;
    try { await api.updateTree(t.id, { labels }); } catch { saved = false; }
    saveLocalLabels(t.id, labels);
    setTrees((cur) => cur.map((x) => (x.id === t.id
      ? { ...x, labels, members: x.members.map((m) => ({ ...m, label: labels[m.id] })) } : x)));
    pop(saved ? `${person.name} is now in ${circleMeta(key).label}` : 'Label saved on this device only');
  };
  const leaveTree = (t) => setConfirm({
    title: t.mine ? 'Delete this tree?' : 'Leave this tree?',
    body: t.mine ? 'It will be removed for everyone in it.' : 'You will no longer see it or appear in it.',
    okLabel: t.mine ? 'Delete tree' : 'Leave tree',
    danger: true,
    onOk: async () => {
      try { await api.removeTree(t.id); setTrees((cur) => cur.filter((x) => x.id !== t.id)); pop(t.mine ? 'Tree deleted' : 'You left the tree'); }
      catch { pop('Could not do that'); }
    },
  });
  const choose = (fn) => { setDial(false); setDrawer(null); fn(); };
  const pickCircle = (key) => { setFilter(key); setDrawer(null); };

  const idx = viewing ? stories.findIndex((x) => x.id === viewing.id) : -1;
  const goPrev = idx > 0 ? () => open(stories[idx - 1]) : null;
  const goNext = idx >= 0 && idx < stories.length - 1 ? () => open(stories[idx + 1]) : null;
  const memberTree = member && trees.find((t) => t.id === member.treeId);

  return (
    <main className="sq">
      {/* left: actions + my circles */}
      <Drawer side="left" title="My circles" open={drawer === 'left'} onClose={() => setDrawer(null)}>
        <div className="sq-dr">
          <div className="sq-dr__acts">
            <button type="button" className="sq-cta" onClick={() => choose(() => setComposing(true))}>📷 Add status</button>
            <button type="button" className="sq-ghost" onClick={() => choose(() => setThinking(true))}>💭 Share a thought</button>
            <button type="button" className="sq-ghost" onClick={() => choose(() => setTreeOpen(true))}>🌳 New tree</button>
          </div>
          <h3 className="sq-sec">Show me</h3>
          <ul className="sq-circles">
            <li>
              <button type="button" aria-pressed={active === 'all'} onClick={() => pickCircle('all')}>
                <span className="sq-circles__e" aria-hidden="true">✨</span>Everyone<b>{people}</b>
              </button>
            </li>
            {circles.map((c) => (
              <li key={c.key}>
                <button type="button" aria-pressed={active === c.key} style={{ '--c': c.color }} onClick={() => pickCircle(c.key)}>
                  <span className="sq-circles__e" aria-hidden="true">{c.emoji}</span>{c.label}<b>{counts[c.key]}</b>
                </button>
              </li>
            ))}
          </ul>
          {circles.length === 0 && <p className="sq-hint">Circles appear once you plant a tree and label your people.</p>}
          <p className="sq-hint">Statuses only come from people in your friend trees, in a random order. They vanish after 24 hours.</p>
        </div>
      </Drawer>

      <section className="sq-main">
        <header className="sq-hero">
          <div className="sq-hero__bar">
            <button type="button" className="sq-ico sq-only-m" aria-label="Open my circles" onClick={() => setDrawer('left')}>☰</button>
            <div className="sq-hero__title">
              <h1>The Square</h1>
              <p>{people > 0 ? `${plural(people, 'person', 'people')} in your trees` : 'Plant a tree to see your people'}</p>
            </div>
            <button type="button" className="sq-ico sq-only-m" aria-label="Open trending" onClick={() => setDrawer('right')}>🔥</button>
          </div>

          {circles.length > 0 && (
            <div className="sq-chips sq-only-m" role="group" aria-label="Filter by circle">
              <button type="button" aria-pressed={active === 'all'} onClick={() => setFilter('all')}>✨ All</button>
              {circles.map((c) => (
                <button key={c.key} type="button" aria-pressed={active === c.key} onClick={() => setFilter(c.key)}>
                  <span aria-hidden="true">{c.emoji}</span> {c.label}
                </button>
              ))}
            </div>
          )}

          <div className="sq-stories-head">
            <h2>Status updates</h2>
            {stories.length > 2 && <button type="button" className="sq-shuffle" onClick={() => setSeed(Math.random().toString(36).slice(2))}>🔀 Shuffle</button>}
          </div>
          <div className="sq-rings">
            <button type="button" className="sq-ring sq-ring--add" onClick={() => setComposing(true)}>
              <i aria-hidden="true">＋</i><small className="sq-ring__name">Add</small>
            </button>
            {!loaded && [0, 1, 2, 3].map((n) => <span key={n} className="sq-skel" aria-hidden="true" />)}
            {stories.map((s) => {
              const c = labelOf[s.user.id] && circleMeta(labelOf[s.user.id]);
              return (
                <button key={s.id} type="button" className={`sq-ring${seen[s.id] ? ' sq-ring--seen' : ''}`} onClick={() => open(s)}>
                  <i>
                    {s.kind === 'image' ? <img src={s.file} alt="" /> : s.kind === 'video' ? '🎬' : initial(s.user.name)}
                    {c && <em className="sq-badge" aria-hidden="true">{c.emoji}</em>}
                  </i>
                  <small className="sq-ring__name">{s.user.id === user?.id ? 'You' : s.user.name}</small>
                </button>
              );
            })}
          </div>
          {loaded && trees.length === 0 && (
            <p className="sq-hero__note">Statuses show up from people in your friend trees. <button type="button" onClick={() => setTreeOpen(true)}>Plant your first tree</button></p>
          )}
          {loaded && trees.length > 0 && stories.length === 0 && (
            <p className="sq-hero__note">{active === 'all' ? 'No statuses from your people right now.' : 'Nobody in this circle has a status right now.'}</p>
          )}
        </header>

        <div className="sq-body">
          <div className="sq-seg" role="tablist" aria-label="Square sections">
            <button type="button" role="tab" aria-selected={tab === 'thoughts'} onClick={() => setTab('thoughts')}>💭 Thoughts</button>
            <button type="button" role="tab" aria-selected={tab === 'trees'} onClick={() => setTab('trees')}>🌳 Trees{trees.length ? ` · ${trees.length}` : ''}</button>
          </div>

          {tab === 'thoughts' && (
            <>
              <div className="sq-split">
                <div className="sq-tabs" role="group" aria-label="Sort thoughts">
                  <button type="button" aria-pressed={sort === 'new'} onClick={() => setSort('new')}>Newest</button>
                  <button type="button" aria-pressed={sort === 'top'} onClick={() => setSort('top')}>Most reacted</button>
                </div>
              </div>
              {shown.map((t) => (
                <article key={t.id} className="sq-card">
                  <div className="sq-who"><span className="sq-av">{initial(t.user.name)}</span>
                    <div><b>{t.user.name}</b><small>{ago(t.created_at)}</small></div></div>
                  <p className="sq-text">{t.text}</p>
                  <Reactions mine={t.my_reaction} counts={t.reactions} onPick={(e) => reactThought(t, e)} />
                </article>
              ))}
              {shown.length === 0 && <p className="sq-empty">No thoughts yet. Tap ＋ to share the first one.</p>}
            </>
          )}

          {tab === 'trees' && (
            <>
              <div className="sq-split">
                <p className="sq-hint">Only you and the people you tag can see a tree.</p>
                <button type="button" className="sq-cta sq-cta--sm" onClick={() => setTreeOpen(true)}>+ New tree</button>
              </div>
              {trees.length === 0 && (
                <div className="sq-card sq-empty-card">
                  <span aria-hidden="true">🌳</span>
                  <h3>Plant your first tree</h3>
                  <p className="sq-hint">Tag your people and label them: Family, Workmates, Besties… Their statuses will show up here.</p>
                  <button type="button" className="sq-cta" onClick={() => setTreeOpen(true)}>Plant a tree</button>
                </div>
              )}
              {treesShown.map((t) => <TreeCard key={t.id} tree={t} onOpen={(x) => setSheetId(x.id)} />)}
              {trees.length > 0 && treesShown.length === 0 && <p className="sq-empty">No trees in this circle.</p>}
            </>
          )}
        </div>
      </section>

      {/* right: trending */}
      <Drawer side="right" title="Trending" open={drawer === 'right'} onClose={() => setDrawer(null)}>
        <div className="sq-dr">
          <div className="sq-card">
            <h2>🔥 Most liked statuses</h2>
            {trendingStatuses.length === 0 && <p className="sq-hint">Nothing yet.</p>}
            <ul>{trendingStatuses.map((s) => (
              <li key={s.id}><button type="button" onClick={() => open(s)}><strong>{s.user.name}</strong> {s.text || (s.kind === 'video' ? 'Video' : 'Photo')}</button><b>❤️ {s.likes}</b></li>
            ))}</ul>
          </div>
          <div className="sq-card">
            <h2>💬 Trending thoughts</h2>
            {trending.thoughts.length === 0 && <p className="sq-hint">Nothing yet.</p>}
            <ul>{trending.thoughts.map((t) => (
              <li key={t.id}><span>{t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text}</span><b>{t.total}</b></li>
            ))}</ul>
          </div>
          <div className="sq-card">
            <h2>Emoji right now</h2>
            <p className="sq-emoji">{trending.emoji.join(' ') || '—'}</p>
          </div>
        </div>
      </Drawer>

      <div className={`sq-scrim${drawer || dial ? ' is-on' : ''}`} onClick={() => { setDrawer(null); setDial(false); }} aria-hidden="true" />

      {/* floating speed-dial (phones) */}
      {dial && (
        <div className="sq-dial" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(() => setTreeOpen(true))}><span>New tree</span><i aria-hidden="true">🌳</i></button>
          <button type="button" role="menuitem" onClick={() => choose(() => setThinking(true))}><span>Thought</span><i aria-hidden="true">💭</i></button>
          <button type="button" role="menuitem" onClick={() => choose(() => setComposing(true))}><span>Status</span><i aria-hidden="true">📷</i></button>
        </div>
      )}
      <button type="button" className={`sq-fab${dial ? ' is-open' : ''}`} hidden={!!drawer} aria-expanded={dial}
        aria-label={dial ? 'Close menu' : 'Create something'} onClick={() => setDial((d) => !d)}>＋</button>

      <div className="sq-pops" aria-live="polite">
        {pops.map((p) => (
          <button key={p.id} type="button" className="sq-pop"
            onClick={() => { setPops((c) => c.filter((x) => x.id !== p.id)); if (p.status) open(p.status); }}>
            <span aria-hidden="true">{/could not/i.test(p.msg) ? '⚠️' : '✨'}</span>{p.msg}{p.status && <em>View</em>}
          </button>
        ))}
      </div>

      {treeOpen && (
        <PeoplePicker title="New friend tree" submitLabel="Plant tree" askTitle titlePlaceholder="Tree name (e.g. My people)"
          labelOptions={CIRCLES} defaultLabel="friends" compact
          onSubmit={makeTree} onClose={() => setTreeOpen(false)} />
      )}
      {sheetTree && (
        <TreeSheet tree={sheetTree} statusByUser={statusByUser} pop={pop} ask={setConfirm}
          onClose={() => setSheetId(null)} onLeave={leaveTree}
          onMember={(person) => setMember({ treeId: sheetTree.id, person })}
          onStatus={(st) => { setStatuses((cur) => [st, ...cur]); load(); }} />
      )}
      {memberTree && (
        <MemberSheet tree={memberTree} person={member.person} status={statusByUser[member.person.id]}
          canEdit={memberTree.mine} onLabel={setLabel} onClose={() => setMember(null)}
          onStatus={(st) => { setMember(null); setSheetId(null); open(st); }} />
      )}
      {thinking && <ThoughtSheet onClose={() => setThinking(false)} onPosted={(t) => { setThoughts((cur) => [t, ...cur]); setTab('thoughts'); load(); }} />}
      {composing && <Composer onClose={() => setComposing(false)} onPosted={(s) => { setStatuses((cur) => [s, ...cur]); load(); }} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      {viewing && (
        <Viewer status={viewing} circle={labelOf[viewing.user.id] ? circleMeta(labelOf[viewing.user.id]) : null}
          onClose={() => setViewing(null)} onReact={reactStatus} onPrev={goPrev} onNext={goNext} />
      )}
    </main>
  );
}
