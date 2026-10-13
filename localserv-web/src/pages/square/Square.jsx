import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PeoplePicker from '../../components/PeoplePicker';
import { Icon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { BRAND_NAME, BRAND_ASSETS } from '../../brand';
import * as api from '../../api/square';
import { shrinkImage, MAX_STATUS_SECONDS, MAX_SLIDES, MIN_SLIDE_SECONDS, DEFAULT_SLIDE_SECONDS, maxSlideSeconds,
  SHOW_TEMPLATES, SHOW_CANVASES, DEFAULT_TEMPLATE, DEFAULT_CANVAS } from './shrinkMedia';
import { treeBlob, treeFileName } from './treeImage';
import { statusFrameBlob, statusFileName } from './statusImage';
import { CIRCLES, SHARED, circleMeta, fruitFor, hasLabels, labelFor, saveLocalLabels } from './circles';
import './square.css';

const EMOJI = ['🔥', '😂', '❤️', '😮', '👏'];
const POLL_MS = 20000;
const hoursLeft = (iso) => Math.max(1, Math.ceil((new Date(iso) - Date.now()) / 36e5));
const ago = (iso) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
// Which statuses I've watched survives a refresh (per account, this device). Statuses last 24h, so old ids are pruned.
const SEEN_KEY = 'sq-seen-v1';
const readSeen = (uid) => { try { return JSON.parse(localStorage.getItem(`${SEEN_KEY}:${uid}`) || '{}') || {}; } catch { return {}; } };
const writeSeen = (uid, map) => { try { localStorage.setItem(`${SEEN_KEY}:${uid}`, JSON.stringify(map)); } catch { /* private mode: in-memory only */ } };
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
      <Icon name={circle.icon} size={12} />{circle.label}{count != null && <b>{count}</b>}
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

/* One photo of a slideshow on its canvas, with its template's motion. Used by the viewer and by the composer preview,
   so what you pick is exactly what people see. The look names match the backend (blur/fill/frame/night, fade/drift/slide/pop). */
// Small site logo in the corner of every slideshow (viewer + composer preview). The dark-surface logo has a black
// background, so mix-blend-mode: screen (see square.css) makes it disappear; if the file is missing it falls back to text.
function Watermark() {
  const [failed, setFailed] = useState(false);
  return (
    <span className="sq-wm" aria-hidden="true">
      {failed ? <b>hiclr</b> : <img src={BRAND_ASSETS.logoDark} alt="" decoding="async" draggable="false" onError={() => setFailed(true)} />}
    </span>
  );
}

function SlideStage({ url, slideMs, template = DEFAULT_TEMPLATE, canvas = DEFAULT_CANVAS }) {
  return (
    <div className={`sq-show sq-show--${canvas} sq-fx--${template}`} style={{ '--slide-ms': `${slideMs}ms` }}>
      {canvas === 'blur' && <img className="sq-show__bg" src={url} alt="" aria-hidden="true" decoding="async" />}
      <div key={url} className="sq-show__card">
        <img className="sq-show__img" src={url} alt="" decoding="async" />
      </div>
      <Watermark />
    </div>
  );
}

/* ---------- status viewer (tap right = next, left = back, auto-advances; nothing plays longer than 15s) ---------- */
let soundOff = false; // remembered while the page is open, so muting once sticks for the next statuses
const MUSIC_VOL = 0.85;
// One shared <audio>, unlocked inside the tap that opens a status. Browsers (iOS Safari especially) only let an element
// play sound if it was started from a tap; a fresh Audio() created later in an effect (or by the auto-advance timer) is blocked.
// With a track url the real music starts right here, inside the tap, instead of waiting for the viewer to mount.
let sharedAudio = null;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
function primeAudio(url) {
  try {
    if (!sharedAudio) sharedAudio = new Audio();
    const a = sharedAudio;
    a.loop = true;
    a.preload = 'auto';
    a.volume = MUSIC_VOL;
    if (url) { a.muted = soundOff; a.src = url; } else { a.muted = true; a.src = SILENT_WAV; }
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch { /* the viewer falls back to the speaker button */ }
}

function ViewerBody({ status, circle, close, onReact, onPrev, onNext }) {
  const { user } = useAuth();
  const isVideo = status.kind === 'video';
  const slides = useMemo(() => (status.kind === 'slideshow' ? (status.slides || []) : []), [status]);
  const isShow = slides.length > 0;
  const template = SHOW_TEMPLATES.some((t) => t.id === status.template) ? status.template : DEFAULT_TEMPLATE;
  // Each photo shows slide_seconds, but the whole show is clamped to 15s even if the server sent more.
  const slideMs = isShow ? Math.min((status.slide_seconds || DEFAULT_SLIDE_SECONDS) * 1000, (MAX_STATUS_SECONDS * 1000) / slides.length) : 0;
  const ms = isShow ? slideMs * slides.length
    : isVideo ? Math.min(status.duration || MAX_STATUS_SECONDS, MAX_STATUS_SECONDS) * 1000 : 6000;
  const advance = useRef();
  advance.current = () => (onNext ? onNext() : close());
  const holding = useRef(false); // true while a share sheet is open: the auto-advance waits instead of closing it
  useEffect(() => {
    let t;
    const tick = () => { if (holding.current) t = setTimeout(tick, 800); else advance.current(); };
    t = setTimeout(tick, ms + 300);
    return () => clearTimeout(t);
  }, [status.id, ms]);

  // Slideshow: step through the photos, and keep the next one decoded so there is no flash between them.
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!isShow) return undefined;
    const t = setInterval(() => setI((k) => Math.min(k + 1, slides.length - 1)), slideMs);
    return () => clearInterval(t);
  }, [isShow, slideMs, slides.length]);
  useEffect(() => {
    const next = slides[i + 1];
    if (next) { const img = new Image(); img.src = next.url; img.decode?.().catch(() => {}); }
  }, [i, slides]);

  // Music streams from the catalogue's own servers (never stored by us). primeAudio() already started it inside the tap
  // that opened the status; this effect only takes over (same element, same src = no restart), loops if the track is
  // shorter than the show, fades out at the end, and the show plays silently if it fails.
  const track = isShow ? status.music : null;
  const audioRef = useRef(null);
  const [sound, setSound] = useState(soundOff ? 'off' : 'on'); // 'on' | 'off' | 'blocked' | 'failed'
  useEffect(() => {
    if (!track?.url) return undefined;
    if (!sharedAudio) sharedAudio = new Audio();
    const a = sharedAudio;
    a.onerror = () => { console.warn('Status music failed to load', a.error && a.error.code, track.url); setSound('failed'); };
    a.preload = 'auto';
    a.loop = true;
    a.volume = MUSIC_VOL;
    a.muted = soundOff;
    if (a.getAttribute('src') !== track.url) { a.src = track.url; a.currentTime = 0; }
    audioRef.current = a;
    if (a.paused) {
      const p = a.play();
      if (p && p.catch) p.catch((err) => { if (err && err.name === 'NotAllowedError') setSound('blocked'); });
    }
    let fadeTimer;
    const fadeStart = setTimeout(() => {
      fadeTimer = setInterval(() => { a.volume = Math.max(0, a.volume - 0.1); }, 80);
    }, Math.max(0, ms - 900));
    return () => {
      clearTimeout(fadeStart); clearInterval(fadeTimer);
      a.onerror = null; a.pause();
      audioRef.current = null;
    };
  }, [status.id, track?.url, ms]);
  const toggleSound = () => {
    const a = audioRef.current;
    if (!a || sound === 'failed') return;
    if (sound === 'blocked') { a.muted = soundOff; a.play().then(() => setSound(soundOff ? 'off' : 'on')).catch(() => {}); return; }
    soundOff = sound === 'on';
    a.muted = soundOff;
    setSound(soundOff ? 'off' : 'on');
  };

  // Share: the slide on screen, drawn on its canvas with the site logo watermark. Only on your own statuses
  // (friends-only content shouldn't be re-shared by whoever happens to see it); set canSend = isShow || image to open it to viewers.
  const isMine = !!user && String(status.user.id) === String(user.id);
  const canSend = isMine && (isShow || status.kind === 'image');
  const [note, setNote] = useState('');
  const noteTimer = useRef();
  const flash = (m) => { setNote(m); clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => setNote(''), 2200); };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const shareStatus = async () => {
    if (holding.current) return;
    holding.current = true;
    try {
      const src = isShow ? slides[i].url : status.file;
      const blob = await statusFrameBlob(src, isShow ? (status.canvas || DEFAULT_CANVAS) : 'blur');
      const file = new File([blob], statusFileName(status), { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${status.user.name} on ${BRAND_NAME}`, text: status.text || BRAND_NAME });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        flash('Picture saved');
      }
    } catch (e) { if (e?.name !== 'AbortError') flash('Could not make the picture'); }
    holding.current = false;
  };

  const soundLabel = sound === 'failed' ? 'Music unavailable' : sound === 'blocked' ? 'Tap the speaker to play' : track?.credit;

  return (
    <div className="sq-stage">
      {isShow ? (
        <div className="sq-bar sq-bar--seg">
          {slides.map((_, k) => (
            <b key={k}>{k < i ? <span style={{ width: '100%', animation: 'none' }} /> : k === i ? <span key={`${status.id}-${i}`} style={{ animationDuration: `${slideMs}ms` }} /> : null}</b>
          ))}
        </div>
      ) : (
        <div className="sq-bar"><span key={status.id} style={{ animationDuration: `${ms}ms` }} /></div>
      )}
      <div className="sq-vhead">
        <div className="sq-vwho">
          <span className="sq-av sq-av--sm">{initial(status.user.name)}</span>
          <div className="sq-vname">
            <b>{status.user.name}</b>
            <small>{circle ? `${circle.label} · ` : ''}{hoursLeft(status.expires_at)}h left</small>
          </div>
        </div>
        <button type="button" className="sq-x" onClick={close} aria-label="Close"><Icon name="x" size={18} /></button>
      </div>
      {status.kind === 'image' && <img src={status.file} alt="" />}
      {isVideo && <video src={status.file} autoPlay playsInline controls={false} onEnded={() => advance.current()} />}
      {isShow && <SlideStage url={slides[i].url} slideMs={slideMs} template={template} canvas={status.canvas || DEFAULT_CANVAS} />}
      {status.kind === 'text' && <p className="sq-big">{status.text}</p>}
      {status.kind !== 'text' && status.text && <p className="sq-cap">{status.text}</p>}
      {track && (
        <div className={`sq-music is-${sound}`}>
          <span className="sq-eq" aria-hidden="true"><i /><i /><i /></span>
          {track.source_url && sound !== 'failed' && sound !== 'blocked'
            ? <a href={track.source_url} target="_blank" rel="noopener noreferrer" title={track.credit}>{soundLabel}</a>
            : <span title={track.credit}>{soundLabel}</span>}
        </div>
      )}
      {(track || canSend) && (
        <div className="sq-rail">
          {track && (
            <button type="button" className={`sq-rbtn is-${sound}`} onClick={toggleSound} disabled={sound === 'failed'}
              aria-label={sound === 'on' ? 'Mute music' : sound === 'failed' ? 'Music unavailable' : 'Play music'} aria-pressed={sound === 'on'}>
              <Icon name={sound === 'off' || sound === 'failed' ? 'volumeOff' : 'volume'} size={18} />
              {sound === 'blocked' && <i className="sq-rbtn__ping" aria-hidden="true" />}
            </button>
          )}
          {canSend && (
            <button type="button" className="sq-rbtn" onClick={shareStatus} aria-label="Share this status as a picture">
              <Icon name="share" size={18} />
            </button>
          )}
        </div>
      )}
      {note && <div className="sq-note" role="status">{note}</div>}
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
function Bubble({ person, color, big, mid, live, edit, you, onClick }) {
  // hidden = someone else in a tree I was tagged in: shown only as a fruit/gift so the shape stays but the person doesn't
  if (person.hidden) {
    return (
      <span className="sq-bub sq-bub--fruit" style={color ? { '--c': color } : undefined} role="img" aria-label="Someone else in this tree">
        <i aria-hidden="true">{fruitFor(person.id)}</i>
        <small aria-hidden="true">&nbsp;</small>
      </span>
    );
  }
  return (
    <button type="button" className={`sq-bub${big ? ' sq-bub--big' : ''}${mid ? ' sq-bub--mid' : ''}${live ? ' sq-bub--live' : ''}${edit ? ' sq-bub--edit' : ''}${you ? ' sq-bub--you' : ''}`}
      style={color ? { '--c': color } : undefined} onClick={onClick}
      aria-label={edit ? `Remove ${person.name}` : `${person.name}${you ? ' (you)' : ''}${live ? ', has a status' : ''}`}>
      <i>{initial(person.name)}{edit && <em className="sq-bub__x" aria-hidden="true"><Icon name="x" size={9} strokeWidth={3} /></em>}</i>
      <small>{you ? 'You' : person.name}</small>
    </button>
  );
}

// Collapsed: only the tree's name, how many people are in it and who planted it.
// Tap to expand a small paged list of the people; "Open tree" shows the full tree in a sheet.
const BRANCH_PER_PAGE = 12;

function Pager({ page, pages, onPage, label = 'People pages' }) {
  if (pages <= 1) return null;
  return (
    <nav className="sq-pager" aria-label={label}>
      <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page"><Icon name="chevronLeft" size={16} /></button>
      <span role="status">{page + 1} / {pages}</span>
      <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page"><Icon name="chevron" size={16} /></button>
    </nav>
  );
}

function TreeCard({ tree, onOpen }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const labelled = hasLabels(tree);
  const bodyId = `tree-${tree.id}`;

  // "You and 3 others": everyone connected to this tree (owner + tagged people) except me
  const others = useMemo(() => {
    const ids = new Set([tree.owner, ...tree.members].map((p) => String(p.id)));
    if (user) ids.delete(String(user.id));
    return ids.size;
  }, [tree, user]);
  // how the owner knows them, in friendly words (only when the labels are known: my own trees)
  const circles = useMemo(() => {
    if (!tree.mine || !labelled) return [];
    const count = {};
    tree.members.filter((m) => !m.hidden).forEach((m) => { const k = labelFor(tree, m); count[k] = (count[k] || 0) + 1; });
    return CIRCLES.filter((c) => count[c.key]).map((c) => ({ ...c, n: count[c.key] }));
  }, [tree, labelled]);
  // Tagged in someone else's tree: my icon is how the owner knows me (Besties, Family, Partner...), when the labels are known.
  const myCircle = useMemo(() => {
    if (tree.mine || !user || !labelled) return null;
    const me = tree.members.find((m) => String(m.id) === String(user.id));
    return me && !me.hidden ? circleMeta(labelFor(tree, me)) : null;
  }, [tree, user, labelled]);
  const headline = others === 0 ? 'Just you so far' : `You and ${plural(others, 'other', 'others')}`;

  return (
    <div className={`sq-card sq-tcard${open ? ' is-open' : ''}`}>
      <button type="button" className="sq-tcard__head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="sq-tcard__leaf" aria-hidden="true"><Icon name="tree" size={18} /></span>
        <span className="sq-tcard__info">
          <b>{tree.title}</b>
          <small>{headline} · by {tree.mine ? 'you' : tree.owner.name}</small>
        </span>
        <span className="sq-chev" aria-hidden="true"><Icon name="chevron" size={18} /></span>
      </button>
      {open && (
        <div className="sq-tcard__body" id={bodyId}>
          <div className="sq-tsum">
            <span className="sq-tsum__you" aria-hidden="true" style={myCircle ? { '--you': myCircle.color } : undefined}>
              <Icon name={tree.mine ? 'heart' : myCircle ? myCircle.icon : 'users'} size={18} />
            </span>
            <span className="sq-tsum__text">
              <b>{headline}</b>
              <small>{others === 0 ? 'Nobody tagged yet.' : `${plural(others, 'contact', 'contacts')} in this tree`}</small>
            </span>
          </div>
          {myCircle && (
            <ul className="sq-tsum__chips" aria-label={`How ${tree.owner.name} knows you`}>
              <li style={{ '--c': myCircle.color }}><Icon name={myCircle.icon} size={13} />{myCircle.label} to {tree.owner.name}</li>
            </ul>
          )}
          {circles.length > 0 && (
            <ul className="sq-tsum__chips" aria-label="How you know them">
              {circles.map((c) => (
                <li key={c.key} style={{ '--c': c.color }}><Icon name={c.icon} size={13} />{c.label}<b>{c.n}</b></li>
              ))}
            </ul>
          )}
          <button type="button" className="sq-cta sq-cta--sm sq-tcard__open" onClick={() => onOpen(tree)}><Icon name="tree" size={15} />Open tree</button>
        </div>
      )}
    </div>
  );
}

// People inside one branch of the open tree: a page at a time when there are many.
function PagedBubs({ people, render }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(people.length / BRANCH_PER_PAGE));
  const safe = Math.min(page, pages - 1);
  return (
    <>
      <div className="sq-bubs">{people.slice(safe * BRANCH_PER_PAGE, (safe + 1) * BRANCH_PER_PAGE).map(render)}</div>
      <Pager page={safe} pages={pages} onPage={setPage} label="Branch pages" />
    </>
  );
}

function TreeSheet({ tree, meId, statusByUser, onClose, onLeave, onStatus, onMember, onRename, onRemove, onAdd, pop, ask }) {
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState(false);
  // Only the account that planted the tree can change it. Everyone tagged in it gets a read-only view.
  const owner = !!tree.mine && (meId == null || String(tree.owner.id) === String(meId));
  const isMe = (p) => !owner && meId != null && String(p.id) === String(meId);
  const [name, setName] = useState(tree.title);
  const saveName = async () => {
    const t = name.trim();
    if (!t || t === tree.title) { setName(tree.title); return; }
    await onRename(tree, t);
  };
  const drop = (person) => ask({
    title: `Remove ${person.name}?`,
    body: 'They will be taken out of this tree and will no longer see it.',
    okLabel: 'Remove',
    danger: true,
    onOk: () => onRemove(tree, person),
  });
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

  // Hierarchy on my own trees: partner(s) are attached to me, then tiers hang down the trunk in order of closeness
  // (family, besties, friends...). One plain tier on trees I was tagged in (those labels are the owner's view).
  const structured = hasLabels(tree);
  const partners = useMemo(() => (structured ? tree.members.filter((m) => labelFor(tree, m) === 'partner') : []), [tree, structured]);
  const groups = useMemo(() => {
    if (!structured) return [{ key: 'in', label: 'In this tree', icon: 'tree', color: 'var(--color-violet)', people: tree.members }];
    return CIRCLES.filter((c) => c.key !== 'partner')
      .map((c) => ({ ...c, people: tree.members.filter((m) => labelFor(tree, m) === c.key) })).filter((g) => g.people.length);
  }, [tree, structured]);

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
      else await navigator.share({ title: tree.title, text: `${tree.title} on ${BRAND_NAME}` });
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
            <div className="sq-sheet__title">
              {edit
                ? <input type="text" className="sq-rename" value={name} maxLength={60} aria-label="Tree name"
                    onChange={(e) => setName(e.target.value)} onBlur={saveName}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                : <h2>{tree.title}</h2>}
              <small>{(() => { const n = new Set([tree.owner, ...tree.members].map((p) => String(p.id))); if (meId != null) n.delete(String(meId)); else n.delete(String(tree.owner.id)); return n.size === 0 ? 'Just you so far' : `You and ${plural(n.size, 'other', 'others')}`; })()}</small>
            </div>
            {owner && (
              <button type="button" className={`sq-edit${edit ? ' is-on' : ''}`} aria-pressed={edit}
                onClick={() => { if (edit) saveName(); setEdit((v) => !v); }}><Icon name={edit ? 'check' : 'pencil'} size={14} />{edit ? 'Done' : 'Edit'}</button>
            )}
            <button type="button" className="sq-x sq-x--soft" onClick={close} aria-label="Close"><Icon name="x" size={18} /></button>
          </header>
          {tree.note && <p className="sq-hint">{tree.note}</p>}
          {!owner && (
            <div className="sq-viewonly">
              <Icon name="eye" size={16} />
              <span className="sq-viewonly__txt">View only. {tree.owner.name} planted this tree; your spot is the one that glows. Everyone else stays hidden as 🍎🎁.</span>
              <button type="button" className="sq-viewonly__leave" onClick={() => onLeave(tree)}>Remove me</button>
            </div>
          )}
          <div className={`sq-tree${edit ? ' is-editing' : ''}`}>
            <div className="sq-core">
              <Bubble person={tree.owner} big you={isMe(tree.owner)} live={!!statusByUser[tree.owner.id]} onClick={() => onMember(tree.owner)} />
              {partners.map((m) => (
                <span key={m.id} className="sq-mate">
                  <span className="sq-mate__link" aria-hidden="true"><Icon name="heart" size={11} strokeWidth={2.4} /></span>
                  <Bubble person={m} color={circleMeta('partner').color} mid edit={edit && owner} you={isMe(m)} live={!edit && !!statusByUser[m.id]}
                    onClick={() => (edit && owner ? drop(m) : onMember(m))} />
                </span>
              ))}
            </div>
            {groups.length > 0 && <span className="sq-trunk" aria-hidden="true" />}
            <div className="sq-branches">
              {groups.map((g, gi) => (
                <section key={g.key} className="sq-branch" style={{ '--c': g.color, '--bs': `${Math.max(28, 38 - gi * 2)}px` }}>
                  <h4><Icon name={g.icon} size={13} />{g.label}<b>{g.people.length}</b></h4>
                  <PagedBubs people={g.people} render={(m) => (
                    <Bubble key={m.id} person={m} color={g.color} edit={edit && owner} you={isMe(m)} live={!edit && !!statusByUser[m.id]}
                      onClick={() => (edit && owner ? drop(m) : onMember(m))} />
                  )} />
                </section>
              ))}
            </div>
            {tree.members.length === 0 && <p className="sq-hint">Nobody here yet.</p>}
          </div>
          {owner && edit && <button type="button" className="sq-cta sq-cta--sm sq-add" onClick={() => onAdd(tree)}><Icon name="plus" size={15} />Add people</button>}
          {owner && <p className="sq-hint sq-center">{edit ? 'Tap a person to remove them. Rename the tree at the top.' : 'Tap anyone to change how you know them.'}</p>}
          <div className="sq-acts">
            <button type="button" className="sq-ghost" onClick={download}><Icon name="download" size={16} />Save image</button>
            {canShare && <button type="button" className="sq-ghost" onClick={share}><Icon name="share" size={16} />Share</button>}
            {owner && <button type="button" className="sq-ghost" disabled={!!busy} onClick={asStatus}><Icon name="sparkle" size={16} />{busy || 'Post as status'}</button>}
            <button type="button" className="sq-ghost sq-ghost--danger" onClick={() => onLeave(tree)}><Icon name={owner ? 'trash' : 'logout'} size={16} />{owner ? 'Delete tree' : 'Leave tree'}</button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

function MemberSheet({ tree, person, status, canEdit, meId, onLabel, onStatus, onRemove, onLeave, onClose }) {
  const isOwner = String(tree.owner.id) === String(person.id);
  const current = !isOwner && hasLabels(tree) ? labelFor(tree, person) : null;
  const itsMe = !canEdit && !isOwner && meId != null && String(person.id) === String(meId);
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
                    <Icon name={c.icon} size={14} />{c.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="sq-row">
            {status && <button type="button" className="sq-cta" onClick={() => onStatus(status)}><Icon name="play" size={15} />View status</button>}
            <Link to={`/profile/${person.id}`} className="sq-ghost sq-ghost--link">View profile</Link>
          </div>
          {canEdit && !isOwner && (
            <button type="button" className="sq-link sq-link--danger" onClick={() => { close(); setTimeout(() => onRemove(tree, person), 190); }}>Remove from tree</button>
          )}
          {itsMe && (
            <button type="button" className="sq-link sq-link--danger" onClick={() => { close(); setTimeout(() => onLeave(tree), 190); }}>Remove me from this tree</button>
          )}
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
  // Each photo is shrunk ONCE, right when it is picked (one at a time), so posting is instant and only small
  // blobs stay in memory: {id, blob (<=1280px), thumb (240px url)}.
  const [photos, setPhotos] = useState([]);
  const [secs, setSecs] = useState(DEFAULT_SLIDE_SECONDS);
  const [music, setMusic] = useState(null);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [canvas, setCanvas] = useState(DEFAULT_CANVAS);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const n = photos.length;
  const isShow = n >= 2;
  const maxSecs = maxSlideSeconds(n);
  const eachSecs = Math.min(secs, maxSecs);
  const total = isShow ? n * eachSecs : 0;

  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.thumb)), []);

  const addFiles = async (list) => {
    const files = Array.from(list || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return setErr('Choose photos (videos are not supported anymore).');
    setErr('');
    const room = MAX_SLIDES - photosRef.current.length;
    if (files.length > room) setErr(`A slideshow can have up to ${MAX_SLIDES} photos (${MAX_STATUS_SECONDS}s at most).`);
    try {
      for (const f of files.slice(0, Math.max(0, room))) {
        setBusy('Preparing photos…');
        const blob = await shrinkImage(f);
        const thumb = URL.createObjectURL(await shrinkImage(blob, 240, 0.65));
        setPhotos((cur) => [...cur, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, blob, thumb }]);
      }
    } catch (e) {
      setErr(e.message || 'Could not read that photo.');
    }
    setBusy('');
  };
  const removeAt = (k) => setPhotos((cur) => { URL.revokeObjectURL(cur[k].thumb); return cur.filter((_, x) => x !== k); });
  const move = (k, d) => setPhotos((cur) => {
    const to = k + d;
    if (to < 0 || to >= cur.length) return cur;
    const next = cur.slice();
    [next[k], next[to]] = [next[to], next[k]];
    return next;
  });
  // The chosen track plays under the live preview, so you hear exactly what viewers will. It is started inside the "Use" tap
  // (iOS only allows sound from a tap) and stops when it is removed, when the show drops below 2 photos, or on close.
  const prevAudio = useRef(null);
  const prevOffRef = useRef(false);
  const [prevOff, setPrevOff] = useState(false);
  const stopPrev = useCallback(() => {
    const a = prevAudio.current;
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); prevAudio.current = null; }
  }, []);
  const chooseMusic = (t) => {
    stopPrev();
    setMusic(t);
    if (t?.url) {
      const a = new Audio(t.url);
      a.loop = true; a.volume = MUSIC_VOL; a.muted = prevOffRef.current;
      prevAudio.current = a;
      a.play().catch(() => {});
    }
  };
  const togglePrevSound = () => {
    prevOffRef.current = !prevOffRef.current;
    setPrevOff(prevOffRef.current);
    if (prevAudio.current) prevAudio.current.muted = prevOffRef.current;
  };
  useEffect(() => stopPrev, [stopPrev]);
  useEffect(() => { if (n < 2) { setMusic(null); stopPrev(); } }, [n, stopPrev]); // music only goes with a slideshow

  const canPost = n > 0 || text.trim().length > 0;
  const submit = async (close) => {
    setErr('');
    if (!canPost) return setErr('Add a photo or write something first.');
    try {
      const fd = new FormData();
      fd.append('text', text.trim());
      if (n === 1) {
        fd.append('file', photos[0].blob, 'status.jpg');
      } else if (n >= 2) {
        fd.append('slide_seconds', String(eachSecs));
        fd.append('template', template);
        fd.append('canvas', canvas);
        if (music) fd.append('music', JSON.stringify({ provider: music.provider, id: music.id }));
        photos.forEach((p, k) => fd.append('slides', p.blob, `slide${k}.jpg`));
      }
      setBusy('Posting…');
      onPosted(await api.createStatus(fd));
      close();
    } catch (e) {
      const b = e.body || {};
      setErr(b.slides?.[0] || b.template?.[0] || b.canvas?.[0] || b.music?.[0] || b.slide_seconds?.[0] || b.file?.[0] || b.detail || e.message || 'Could not post. Try again.');
      setBusy('');
    }
  };
  const postLabel = busy || (isShow ? `Post slideshow · ${total}s` : n === 1 ? 'Post photo' : 'Post status');

  return (
    <Overlay sheet label="New status" onClose={onClose}>
      {(close) => (
        <div className="sq-sheet sq-compose">
          <span className="sq-grab" aria-hidden="true" />
          <header className="sq-compose__head">
            <div>
              <h2>New status</h2>
              <p>Shared with your friend trees · gone in 24h</p>
            </div>
            <button type="button" className="sq-x sq-x--soft" onClick={close} disabled={!!busy} aria-label="Close"><Icon name="x" size={18} /></button>
          </header>

          {/* ---- 1. photos ---- */}
          {n === 0 ? (
            <label className="sq-hero-drop">
              <span className="sq-hero-drop__ico" aria-hidden="true"><Icon name="camera" size={28} /></span>
              <b>Pick your photos</b>
              <small>Add one photo, or up to {MAX_SLIDES} to make a slideshow</small>
              <span className="sq-hero-drop__tags" aria-hidden="true">
                <em>1–{MAX_SLIDES} photos</em><em>♪ free music</em><em>{MAX_STATUS_SECONDS}s max</em>
              </span>
              <input type="file" accept="image/*" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          ) : (
            <section className="sq-step">
              <h3><i>1</i>Photos <small>{n}/{MAX_SLIDES}{isShow ? ' · tap ‹ › to reorder' : ''}</small></h3>
              <ul className="sq-thumbs" aria-label="Your photos, in play order">
                {photos.map((p, k) => (
                  <li key={p.id}>
                    <img src={p.thumb} alt={`Photo ${k + 1}`} />
                    <span className="sq-thumbs__no" aria-hidden="true">{k + 1}</span>
                    <button type="button" className="sq-x sq-x--dark" aria-label={`Remove photo ${k + 1}`} onClick={() => removeAt(k)}><Icon name="x" size={14} /></button>
                    {isShow && (
                      <span className="sq-thumbs__move">
                        <button type="button" disabled={k === 0} aria-label="Move earlier" onClick={() => move(k, -1)}>‹</button>
                        <button type="button" disabled={k === n - 1} aria-label="Move later" onClick={() => move(k, 1)}>›</button>
                      </span>
                    )}
                  </li>
                ))}
                {n < MAX_SLIDES && (
                  <li className="sq-thumbs__addwrap">
                    <label className="sq-thumbs__add" aria-label="Add more photos">
                      <Icon name="plus" size={20} /><small>Add</small>
                      <input type="file" accept="image/*" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                    </label>
                  </li>
                )}
              </ul>
              {n === 1 && <p className="sq-nudge">Add 1 more photo to unlock <b>slideshow styles</b> and <b>music</b>.</p>}
            </section>
          )}

          {/* ---- 2. look ---- */}
          {isShow && (
            <section className="sq-step">
              <h3><i>2</i>Look <small>live preview</small></h3>
              <div className="sq-look">
                <ShowPreview photos={photos} slideMs={eachSecs * 1000} template={template} canvas={canvas} hasMusic={!!music} off={prevOff} onToggleSound={togglePrevSound} />
                <div className="sq-look__opts">
                  <b>Style</b>
                  <div className="sq-tiles" role="radiogroup" aria-label="Slideshow style">
                    {SHOW_TEMPLATES.map((t) => (
                      <button key={t.id} type="button" role="radio" aria-checked={template === t.id}
                        className={`sq-tile${template === t.id ? ' is-on' : ''}`} onClick={() => setTemplate(t.id)}>
                        <span className="sq-tile__ico" aria-hidden="true">{{ fade: '◐', drift: '⤢', slide: '➜', pop: '✦', cinema: '🎬', burst: '💥', spin: '🌀', flip: '⇋', curtain: '🎭', flash: '⚡', swing: '🎠', zoomout: '🔭' }[t.id]}</span>{t.label}
                      </button>
                    ))}
                  </div>
                  <b>Canvas</b>
                  <div className="sq-tiles" role="radiogroup" aria-label="Slideshow canvas">
                    {SHOW_CANVASES.map((c) => (
                      <button key={c.id} type="button" role="radio" aria-checked={canvas === c.id}
                        className={`sq-tile${canvas === c.id ? ' is-on' : ''}`} onClick={() => setCanvas(c.id)}>
                        <span className={`sq-tile__sw sq-tile__sw--${c.id}`} aria-hidden="true"><i /></span>{c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="sq-time">
                <div className="sq-time__bar" role="img" aria-label={`${total} of ${MAX_STATUS_SECONDS} seconds used`}><span style={{ width: `${(total / MAX_STATUS_SECONDS) * 100}%` }} /></div>
                <p><b>{total}s</b> of {MAX_STATUS_SECONDS}s · {n} photos × {eachSecs}s</p>
                {maxSecs > MIN_SLIDE_SECONDS ? (
                  <label>
                    <span>Time per photo</span>
                    <input type="range" min={MIN_SLIDE_SECONDS} max={maxSecs} step={1} value={eachSecs}
                      onChange={(e) => setSecs(Number(e.target.value))} aria-label="Seconds per photo" />
                  </label>
                ) : (
                  <small className="sq-hint">With {n} photos each one shows {MIN_SLIDE_SECONDS}s so the show fits in {MAX_STATUS_SECONDS}s.</small>
                )}
              </div>
            </section>
          )}

          {/* ---- 3. music ---- */}
          {isShow && (
            <section className="sq-step">
              <h3><i>3</i>Music <small>optional</small></h3>
              <MusicPicker value={music} onChange={chooseMusic} />
            </section>
          )}

          {/* ---- caption ---- */}
          <section className="sq-step">
            <h3><i>{isShow ? 4 : n === 1 ? 2 : 1}</i>{n ? 'Caption' : 'Or just write something'} <small>optional</small></h3>
            <div className="sq-field">
              <input type="text" maxLength={140} placeholder={n ? 'Say something about it…' : 'What\'s on your mind?'} value={text}
                onChange={(e) => setText(e.target.value)} />
              <small className="sq-counter">{text.length}/140</small>
            </div>
          </section>

          {err && <p className="sq-err" role="alert">{err}</p>}
          <div className="sq-foot">
            <div className="sq-row">
              <button type="button" className="sq-ghost" disabled={!!busy} onClick={close}>Cancel</button>
              <button type="button" className="sq-cta" disabled={!!busy || !canPost} onClick={() => submit(close)}>{postLabel}</button>
            </div>
          </div>
        </div>
      )}
    </Overlay>
  );
}

// Loops the chosen photos in a small phone-shaped box with the picked style + canvas (uses the tiny thumbnails only).
function ShowPreview({ photos, slideMs, template, canvas, hasMusic, off, onToggleSound }) {
  const [i, setI] = useState(0);
  const count = photos.length;
  useEffect(() => {
    const t = setInterval(() => setI((k) => (k + 1) % count), slideMs);
    return () => clearInterval(t);
  }, [count, slideMs]);
  const p = photos[i % count];
  return (
    <div className="sq-showprev" aria-label="Preview of your slideshow">
      <SlideStage url={p.thumb} slideMs={slideMs} template={template} canvas={canvas} />
      {hasMusic && (
        <button type="button" className="sq-rbtn sq-rbtn--mini" onClick={onToggleSound} aria-pressed={!off}
          aria-label={off ? 'Play the music in this preview' : 'Mute the music in this preview'}>
          <Icon name={off ? 'volumeOff' : 'volume'} size={14} />
        </button>
      )}
    </div>
  );
}

// Search free-to-use tracks (CC0 / public domain / CC-BY). Only {provider, id} is ever sent back to the server.
function MusicPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [state, setState] = useState('idle'); // idle | loading | done
  const [sugg, setSugg] = useState([]);
  const [suggBusy, setSuggBusy] = useState(true);
  const [suggFailed, setSuggFailed] = useState(false);
  const [playing, setPlaying] = useState(null);
  const audio = useRef(null);
  const stopPreview = useCallback(() => {
    const a = audio.current;
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); audio.current = null; }
    setPlaying(null);
  }, []);
  useEffect(() => stopPreview, [stopPreview]);

  const suggestRef = useRef(sugg);
  suggestRef.current = sugg;
  const reroll = useCallback(async () => {
    setSuggBusy(true);
    setSuggFailed(false);
    try {
      // The server picks 2 random tracks from a pool it shares between everyone; we say which ones we already showed.
      const data = await api.suggestMusic(suggestRef.current.map((t) => t.id));
      setSugg(data.results || []);
    } catch {
      setSugg([]);
      setSuggFailed(true); // a real error (offline / backend not updated), as opposed to "no tracks"
    }
    setSuggBusy(false);
  }, []);
  useEffect(() => { reroll(); }, [reroll]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setState('idle'); return undefined; }
    let live = true;
    setState('loading');
    const t = setTimeout(async () => {
      try {
        const data = await api.searchMusic(term);
        if (live) { setResults(data.results || []); setState('done'); }
      } catch {
        if (live) { setResults([]); setState('done'); }
      }
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const preview = (t) => {
    if (playing === t.id) return stopPreview();
    stopPreview();
    const a = new Audio(t.url); // only fetched when you tap play
    a.volume = 0.8;
    a.onended = stopPreview;
    a.onerror = stopPreview;
    audio.current = a;
    setPlaying(t.id);
    a.play().catch(stopPreview);
    setTimeout(() => { if (audio.current === a) stopPreview(); }, MAX_STATUS_SECONDS * 1000); // a preview never runs past 15s either
  };
  const pick = (t) => { stopPreview(); onChange(t); setQ(''); setResults([]); setState('idle'); };

  const row = (t) => (
    <li key={`${t.provider}-${t.id}`} className="sq-track">
      <button type="button" className={`sq-track__play${playing === t.id ? ' is-on' : ''}`} onClick={() => preview(t)}
        aria-label={playing === t.id ? `Stop ${t.title}` : `Preview ${t.title}`}>
        <Icon name={playing === t.id ? 'x' : 'play'} size={14} />
      </button>
      <span className="sq-track__txt"><strong>{t.title}</strong><small>{t.artist || 'Unknown artist'}</small></span>
      <button type="button" className="sq-track__use" onClick={() => pick(t)}>Use</button>
    </li>
  );

  if (value) {
    return (
      <div className="sq-music-pick">
        <div className="sq-track sq-track--on">
          <span className="sq-track__ico" aria-hidden="true">♪</span>
          <span className="sq-track__txt"><strong>{value.title}</strong><small>{value.artist || 'Unknown artist'} · plays with your slideshow</small></span>
          <button type="button" className="sq-ghost sq-cta--sm" onClick={() => onChange(null)}>Change</button>
        </div>
      </div>
    );
  }
  return (
    <div className="sq-music-pick">
      <input type="search" placeholder="Search free music (lofi, afrobeat, piano…)" value={q} maxLength={60}
        onChange={(e) => setQ(e.target.value)} aria-label="Search music" />
      {q.trim().length >= 2 ? (
        <>
          {state === 'loading' && <small className="sq-hint">Searching…</small>}
          {state === 'done' && results.length === 0 && <small className="sq-hint">No free tracks for that. Try another word, or pick a suggestion.</small>}
          {results.length > 0 && <ul className="sq-tracks">{results.map(row)}</ul>}
        </>
      ) : (
        <div className="sq-suggest">
          <div className="sq-suggest__head">
            <b>Suggested for you</b>
            <button type="button" className="sq-shuffle" onClick={reroll} disabled={suggBusy}><Icon name="shuffle" size={13} />{suggFailed ? 'Retry' : 'Shuffle'}</button>
          </div>
          {suggBusy && sugg.length === 0 && <small className="sq-hint">Finding tracks…</small>}
          {!suggBusy && sugg.length === 0 && (
            <small className="sq-hint">
              {suggFailed ? 'Could not reach the music service. Tap Shuffle to retry, or post without music.' : 'No free tracks right now. Try a search above, or post without music.'}
            </small>
          )}
          {sugg.length > 0 && <ul className="sq-tracks">{sugg.map(row)}</ul>}
        </div>
      )}
      <small className="sq-hint">Free-to-use tracks only. The artist is credited on your status.</small>
    </div>
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
        <button type="button" className="sq-x sq-x--soft" onClick={onClose} aria-label={`Close ${title}`}><Icon name="x" size={18} /></button>
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
  const [addingTo, setAddingTo] = useState(null);
  const [seen, setSeen] = useState(() => readSeen(user?.id));
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
      setSeen((cur) => {
        // the server's word wins; the local copy covers the moment before a save lands (or an older backend)
        const merged = { ...cur };
        s.forEach((x) => { if (x.seen) merged[x.id] = true; });
        const live = new Set(s.map((x) => x.id));
        const keep = Object.fromEntries(Object.entries(merged).filter(([id]) => live.has(id)));
        if (user) writeSeen(user.id, keep);
        return keep;
      });
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
  const open = (s) => {
    primeAudio(s.kind === 'slideshow' ? s.music?.url : null); // inside the tap: unlocks audio and starts this status's music at once
    setSeen((x) => { const n = { ...x, [s.id]: true }; if (user) writeSeen(user.id, n); return n; });
    if (!s.seen && s.user.id !== user?.id) api.markSeen(s.id).catch(() => { /* local copy still marks it */ });
    setViewing(s); setDrawer(null);
  };
  const reactStatus = async (s, emoji) => {
    try { const u = await api.reactStatus(s.id, emoji); swap(setStatuses)(u); setViewing((v) => (v?.id === u.id ? u : v)); load(); } catch { pop('Could not send that reaction'); }
  };
  const reactThought = async (t, emoji) => {
    try { swap(setThoughts)(await api.reactThought(t.id, emoji)); load(); } catch { pop('Could not send that reaction'); }
  };
  // a tree is editable only by the account that created it
  const ownsTree = (t) => !!t?.mine && (!user || String(t.owner.id) === String(user.id));
  const makeTree = async (ids, title, labels) => {
    if (!title) throw new Error('Give your tree a name.');
    const t = await api.createTree(title, ids, '', labels);
    if (labels) saveLocalLabels(t.id, labels);
    setTrees((cur) => [t, ...cur]);
    setTreeOpen(false); setTab('trees');
    pop(`"${title}" planted`);
  };
  const setLabel = async (t, person, key) => {
    if (!ownsTree(t)) return;
    const labels = { ...Object.fromEntries(t.members.map((m) => [m.id, labelFor(t, m)])), [person.id]: key };
    let saved = true;
    try { await api.updateTree(t.id, { labels }); } catch { saved = false; }
    saveLocalLabels(t.id, labels);
    setTrees((cur) => cur.map((x) => (x.id === t.id
      ? { ...x, labels, members: x.members.map((m) => ({ ...m, label: labels[m.id] })) } : x)));
    pop(saved ? `${person.name} is now in ${circleMeta(key).label}` : 'Label saved on this device only');
  };
  const refreshTrees = async () => { try { setTrees(await api.listTrees()); } catch { /* keep local copy */ } };
  const renameTree = async (t, title) => {
    if (!ownsTree(t)) return;
    setTrees((cur) => cur.map((x) => (x.id === t.id ? { ...x, title } : x)));
    try { await api.updateTree(t.id, { title }); pop('Tree renamed'); }
    catch { setTrees((cur) => cur.map((x) => (x.id === t.id ? { ...x, title: t.title } : x))); pop('Could not rename the tree'); }
  };
  const removeMember = async (t, person) => {
    if (!ownsTree(t)) { pop('Only the tree owner can remove people'); return; }
    const rest = t.members.filter((m) => String(m.id) !== String(person.id));
    if (rest.length === 0) { setMember(null); pop('A tree needs at least one person. Delete the tree instead.'); return; }
    const labels = Object.fromEntries(rest.map((m) => [m.id, labelFor(t, m)]));
    const before = trees;
    setTrees((cur) => cur.map((x) => (x.id === t.id ? { ...x, members: rest, labels } : x)));
    setMember(null);
    try { await api.updateTree(t.id, { members: rest.map((m) => m.id), labels }); saveLocalLabels(t.id, labels); pop(`${person.name} removed`); refreshTrees(); }
    catch { setTrees(before); pop('Could not remove that person'); }
  };
  const addPeople = async (ids, _title, newLabels) => {
    const t = trees.find((x) => x.id === addingTo);
    if (!t || !ownsTree(t)) return;
    const labels = { ...Object.fromEntries(t.members.map((m) => [m.id, labelFor(t, m)])), ...newLabels };
    const members = [...new Set([...t.members.map((m) => String(m.id)), ...ids])];
    await api.updateTree(t.id, { members, labels });
    saveLocalLabels(t.id, labels);
    await refreshTrees();
    setAddingTo(null);
    pop(`Added ${plural(ids.length, 'person', 'people')}`);
  };
  const leaveTree = (t) => setConfirm({
    title: ownsTree(t) ? 'Delete this tree?' : 'Remove yourself from this tree?',
    body: ownsTree(t) ? 'It will be removed for everyone in it.' : 'You will no longer see it or appear in it. Only the owner can add you back.',
    okLabel: ownsTree(t) ? 'Delete tree' : 'Remove me',
    danger: true,
    onOk: async () => {
      try {
        try { await api.removeTree(t.id); }
        catch (e) {
          // Some servers only let the owner DELETE; a tagged person can still be taken out by updating the member list.
          if (ownsTree(t) || ![403, 404, 405].includes(e?.status)) throw e;
          const rest = t.members.filter((m) => String(m.id) !== String(user?.id)).map((m) => m.id);
          await api.updateTree(t.id, { members: rest });
        }
        setTrees((cur) => cur.filter((x) => x.id !== t.id));
        setSheetId(null); setMember(null);
        pop(ownsTree(t) ? 'Tree deleted' : 'You removed yourself from the tree');
      } catch (e) { pop(e?.body?.detail || 'Could not do that'); }
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
            <button type="button" className="sq-cta" onClick={() => choose(() => setComposing(true))}><Icon name="camera" size={17} />Add status</button>
            <button type="button" className="sq-ghost" onClick={() => choose(() => setThinking(true))}><Icon name="thought" size={17} />Share a thought</button>
            <button type="button" className="sq-ghost" onClick={() => choose(() => setTreeOpen(true))}><Icon name="tree" size={17} />New tree</button>
          </div>
          <h3 className="sq-sec">Show me</h3>
          <ul className="sq-circles">
            <li>
              <button type="button" aria-pressed={active === 'all'} onClick={() => pickCircle('all')}>
                <span className="sq-circles__e" aria-hidden="true"><Icon name="sparkle" size={16} /></span>Everyone<b>{people}</b>
              </button>
            </li>
            {circles.map((c) => (
              <li key={c.key}>
                <button type="button" aria-pressed={active === c.key} style={{ '--c': c.color }} onClick={() => pickCircle(c.key)}>
                  <span className="sq-circles__e" aria-hidden="true"><Icon name={c.icon} size={16} /></span>{c.label}<b>{counts[c.key]}</b>
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
            <button type="button" className="sq-ico sq-only-m" aria-label="Open my circles" onClick={() => setDrawer('left')}><Icon name="menu" size={20} /></button>
            <div className="sq-hero__title">
              <h1>The Square</h1>
              <p>{people > 0 ? `${plural(people, 'person', 'people')} in your trees` : 'Plant a tree to see your people'}</p>
            </div>
            <button type="button" className="sq-ico sq-only-m" aria-label="Open trending" onClick={() => setDrawer('right')}><Icon name="flame" size={20} /></button>
          </div>

          {circles.length > 0 && (
            <div className="sq-chips sq-only-m" role="group" aria-label="Filter by circle">
              <button type="button" aria-pressed={active === 'all'} onClick={() => setFilter('all')}><Icon name="sparkle" size={13} />All</button>
              {circles.map((c) => (
                <button key={c.key} type="button" aria-pressed={active === c.key} onClick={() => setFilter(c.key)}>
                  <Icon name={c.icon} size={13} />{c.label}
                </button>
              ))}
            </div>
          )}

          <div className="sq-stories-head">
            <h2>Status updates</h2>
            {stories.length > 2 && <button type="button" className="sq-shuffle" onClick={() => setSeed(Math.random().toString(36).slice(2))}><Icon name="shuffle" size={13} />Shuffle</button>}
          </div>
          <div className="sq-rings">
            <button type="button" className="sq-ring sq-ring--add" onClick={() => setComposing(true)}>
              <i aria-hidden="true"><Icon name="plus" size={22} /></i><small className="sq-ring__name">Add</small>
            </button>
            {!loaded && [0, 1, 2, 3].map((n) => <span key={n} className="sq-skel" aria-hidden="true" />)}
            {stories.map((s) => {
              const c = labelOf[s.user.id] && circleMeta(labelOf[s.user.id]);
              return (
                <button key={s.id} type="button" className={`sq-ring${seen[s.id] ? ' sq-ring--seen' : ''}`} onClick={() => open(s)}>
                  <i>
                    {s.kind === 'image' ? <img src={s.file} alt="" /> : s.kind === 'slideshow' ? <><img src={s.cover || s.slides?.[0]?.url} alt="" loading="lazy" decoding="async" /><span className="sq-ring__count" aria-hidden="true">{s.music ? '♪ ' : ''}{s.slides?.length || ''}</span></> : s.kind === 'video' ? <><video src={`${s.file}#t=0.5`} muted playsInline preload="metadata" controls={false} disablePictureInPicture aria-hidden="true" tabIndex={-1} /><span className="sq-ring__play" aria-hidden="true"><Icon name="play" size={12} /></span></> : initial(s.user.name)}
                    {c && <em className="sq-badge" aria-hidden="true" style={{ '--c': c.color }}><Icon name={c.icon} size={11} strokeWidth={2.2} /></em>}
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
            <button type="button" role="tab" aria-selected={tab === 'thoughts'} onClick={() => setTab('thoughts')}><Icon name="thought" size={16} />Thoughts</button>
            <button type="button" role="tab" aria-selected={tab === 'trees'} onClick={() => setTab('trees')}><Icon name="tree" size={16} />Trees{trees.length > 0 && <b className="sq-seg__n">{trees.length}</b>}</button>
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
              {shown.length === 0 && <p className="sq-empty">No thoughts yet. Tap the plus button to share the first one.</p>}
            </>
          )}

          {tab === 'trees' && (
            <>
              <div className="sq-trees-head">
                <div>
                  <h2>Your trees</h2>
                  <p className="sq-hint">Only you and the people you tag can see a tree.</p>
                </div>
                <button type="button" className="sq-plant" onClick={() => setTreeOpen(true)}><Icon name="plus" size={16} />New tree</button>
              </div>
              {trees.length === 0 && (
                <div className="sq-card sq-empty-card">
                  <span className="sq-empty-card__ico" aria-hidden="true"><Icon name="tree" size={26} /></span>
                  <h3>Plant your first tree</h3>
                  <p className="sq-hint">Tag your people and label them: Family, Workmates, Besties… Their statuses will show up here.</p>
                  <button type="button" className="sq-plant" onClick={() => setTreeOpen(true)}><Icon name="plus" size={16} />Plant a tree</button>
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
            <h2><Icon name="flame" size={16} />Most liked statuses</h2>
            {trendingStatuses.length === 0 && <p className="sq-hint">Nothing yet.</p>}
            <ol className="sq-rank">{trendingStatuses.map((s, i) => (
              <li key={s.id}><i aria-hidden="true">{i + 1}</i><button type="button" onClick={() => open(s)}><strong>{s.user.name}</strong> {s.text || (s.kind === 'slideshow' ? 'Slideshow' : s.kind === 'video' ? 'Video' : 'Photo')}</button><b><Icon name="heart" size={13} />{s.likes}</b></li>
            ))}</ol>
          </div>
          <div className="sq-card">
            <h2><Icon name="trending" size={16} />Trending thoughts</h2>
            {trending.thoughts.length === 0 && <p className="sq-hint">Nothing yet.</p>}
            <ol className="sq-rank">{trending.thoughts.map((t, i) => (
              <li key={t.id}><i aria-hidden="true">{i + 1}</i><span>{t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text}</span><b>{t.total}</b></li>
            ))}</ol>
          </div>
          <div className="sq-card">
            <h2><Icon name="sparkle" size={16} />Emoji right now</h2>
            <p className="sq-emoji">{trending.emoji.join(' ') || '—'}</p>
          </div>
        </div>
      </Drawer>

      <div className={`sq-scrim${drawer || dial ? ' is-on' : ''}`} onClick={() => { setDrawer(null); setDial(false); }} aria-hidden="true" />

      {/* floating speed-dial (phones) */}
      {dial && (
        <div className="sq-dial" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(() => setTreeOpen(true))}><span>New tree</span><i aria-hidden="true"><Icon name="tree" size={20} /></i></button>
          <button type="button" role="menuitem" onClick={() => choose(() => setThinking(true))}><span>Thought</span><i aria-hidden="true"><Icon name="thought" size={20} /></i></button>
          <button type="button" role="menuitem" onClick={() => choose(() => setComposing(true))}><span>Status</span><i aria-hidden="true"><Icon name="camera" size={20} /></i></button>
        </div>
      )}
      <button type="button" className={`sq-fab${dial ? ' is-open' : ''}`} hidden={!!drawer} aria-expanded={dial}
        aria-label={dial ? 'Close menu' : 'Create something'} onClick={() => setDial((d) => !d)}><Icon name="plus" size={26} strokeWidth={2.2} /></button>

      <div className="sq-pops" aria-live="polite">
        {pops.map((p) => (
          <button key={p.id} type="button" className="sq-pop"
            onClick={() => { setPops((c) => c.filter((x) => x.id !== p.id)); if (p.status) open(p.status); }}>
            <span className={`sq-pop__ico${/could not/i.test(p.msg) ? ' is-bad' : ''}`} aria-hidden="true"><Icon name={/could not/i.test(p.msg) ? 'alert' : 'sparkle'} size={15} /></span>{p.msg}{p.status && <em>View</em>}
          </button>
        ))}
      </div>

      {treeOpen && (
        <PeoplePicker title="New friend tree" submitLabel="Plant tree" askTitle titleLabel="Tree name" titlePlaceholder="e.g. My people"
          labelOptions={CIRCLES} defaultLabel="friends" compact
          onSubmit={makeTree} onClose={() => setTreeOpen(false)} />
      )}
      {addingTo && sheetTree && (
        <PeoplePicker title="Add people" submitLabel="Add to tree" labelOptions={CIRCLES} defaultLabel="friends" compact
          excludeIds={[sheetTree.owner.id, ...sheetTree.members.map((m) => m.id)]} maxPick={Math.max(1, 30 - sheetTree.members.length)}
          onSubmit={addPeople} onClose={() => setAddingTo(null)} />
      )}
      {sheetTree && (
        <TreeSheet tree={sheetTree} meId={user?.id} statusByUser={statusByUser} pop={pop} ask={setConfirm}
          onClose={() => setSheetId(null)} onLeave={leaveTree}
          onRename={renameTree} onRemove={removeMember} onAdd={(t) => setAddingTo(t.id)}
          onMember={(person) => setMember({ treeId: sheetTree.id, person })}
          onStatus={(st) => { setStatuses((cur) => [st, ...cur]); load(); }} />
      )}
      {memberTree && (
        <MemberSheet tree={memberTree} person={member.person} status={statusByUser[member.person.id]}
          canEdit={ownsTree(memberTree)} meId={user?.id} onLabel={setLabel} onRemove={removeMember} onLeave={leaveTree} onClose={() => setMember(null)}
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
