import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PeoplePicker from '../../components/PeoplePicker';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../api/square';
import { shrinkImage, shrinkVideo, MAX_VIDEO_SECONDS } from './shrinkMedia';
import { treeBlob, treeFileName } from './treeImage';
import './square.css';

const EMOJI = ['🔥', '😂', '❤️', '😮', '👏'];
const POLL_MS = 20000;
const hoursLeft = (iso) => Math.max(1, Math.ceil((new Date(iso) - Date.now()) / 36e5));
const ago = (iso) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const initial = (name) => (name || '?').charAt(0).toUpperCase();

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

// Shared modal shell: backdrop click, Escape, scroll lock, smooth enter + exit animation.
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
    const key = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = prevOverflow;
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

function ViewerBody({ status, close, onReact }) {
  const isVideo = status.kind === 'video';
  const ms = isVideo ? Math.min(status.duration || MAX_VIDEO_SECONDS, MAX_VIDEO_SECONDS) * 1000 : 6000;
  useEffect(() => {
    const t = setTimeout(close, ms + 300);
    return () => clearTimeout(t);
  }, [status.id, ms, close]);
  return (
    <div className="sq-stage">
      <div className="sq-bar"><span key={status.id} style={{ animationDuration: `${ms}ms` }} /></div>
      <div className="sq-vhead">
        <div className="sq-vwho">
          <span className="sq-av sq-av--sm">{initial(status.user.name)}</span>
          <div className="sq-vname"><b>{status.user.name}</b><small>{hoursLeft(status.expires_at)}h left</small></div>
        </div>
        <button type="button" className="sq-x" onClick={close} aria-label="Close">✕</button>
      </div>
      {status.kind === 'image' && <img src={status.file} alt="" />}
      {isVideo && <video src={status.file} autoPlay playsInline controls={false} onEnded={close} />}
      {status.kind === 'text' && <p className="sq-big">{status.text}</p>}
      {status.kind !== 'text' && status.text && <p className="sq-cap">{status.text}</p>}
      <div className="sq-vfoot"><Reactions mine={status.my_reaction} onPick={(e) => onReact(status, e)} /></div>
    </div>
  );
}

function Viewer({ status, onClose, onReact }) {
  return (
    <Overlay label={`${status.user.name}'s status`} onClose={onClose}>
      {(close) => <ViewerBody status={status} close={close} onReact={onReact} />}
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

function Bubble({ person, big }) {
  return (
    <Link to={`/profile/${person.id}`} className={`sq-bub${big ? ' sq-bub--big' : ''}`}>
      <i>{initial(person.name)}</i>
      <small>{person.name}</small>
    </Link>
  );
}

function Tree({ tree, onLeave, onStatus, pop, ask }) {
  const [busy, setBusy] = useState('');
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

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
  const asStatus = () => ask({
    title: 'Post this tree as a status?',
    body: 'Everyone on the Square can see it for 24 hours.',
    okLabel: 'Post it',
    onOk: postStatus,
  });
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

  return (
    <article className="sq-card sq-tree">
      <header>
        <h3>{tree.title}</h3>
        <span className="sq-count">{tree.members.length} {tree.members.length === 1 ? 'person' : 'people'}</span>
        {tree.note && <p className="sq-hint">{tree.note}</p>}
      </header>
      <Bubble person={tree.owner} big />
      <div className="sq-branch" aria-hidden="true" />
      <div className="sq-bubs">
        {tree.members.map((m) => <Bubble key={m.id} person={m} />)}
      </div>
      <div className="sq-tree__acts">
        <button type="button" className="sq-ghost" onClick={download}>Download image</button>
        {canShare && <button type="button" className="sq-ghost" onClick={share}>Share</button>}
        <button type="button" className="sq-ghost" disabled={!!busy} onClick={asStatus}>{busy || 'Post as status'}</button>
        <button type="button" className="sq-ghost" onClick={() => onLeave(tree)}>{tree.mine ? 'Delete tree' : 'Leave tree'}</button>
      </div>
    </article>
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
          <p className="sq-hint">Photos are shrunk before upload. Videos are cut to {MAX_VIDEO_SECONDS} seconds. Statuses disappear after 24 hours.</p>
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

export default function Square() {
  const { user } = useAuth();
  const [statuses, setStatuses] = useState([]);
  const [thoughts, setThoughts] = useState([]);
  const [trending, setTrending] = useState({ statuses: [], thoughts: [], emoji: [] });
  const [sort, setSort] = useState('new');
  const [draft, setDraft] = useState('');
  const [thoughtErr, setThoughtErr] = useState('');
  const [viewing, setViewing] = useState(null);
  const [composing, setComposing] = useState(false);
  const [trees, setTrees] = useState([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const [seen, setSeen] = useState({});
  const [pops, setPops] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const prev = useRef(null);

  const pop = useCallback((msg) => {
    const id = Math.random();
    setPops((p) => [...p.slice(-2), { id, msg }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 4500);
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, t, tr, tt] = await Promise.all([
        api.listStatuses(), api.listThoughts(), api.getTrending(), api.listTrees().catch(() => null),
      ]);
      if (tt) setTrees(tt);
      const p = prev.current;
      if (p && user) {
        s.forEach((x) => {
          const old = p.s.find((y) => y.id === x.id);
          if (!old && x.user.id !== user.id) pop(`${x.user.name} posted a status`);
          else if (old && x.user.id === user.id && x.likes > old.likes) pop(`Someone reacted to your status`);
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

  const replace = (list, setList) => (item) => setList(list.map((x) => (x.id === item.id ? item : x)));
  const reactStatus = async (s, emoji) => {
    try { const u = await api.reactStatus(s.id, emoji); replace(statuses, setStatuses)(u); setViewing((v) => (v?.id === u.id ? u : v)); load(); } catch { pop('Could not send that reaction'); }
  };
  const reactThought = async (t, emoji) => {
    try { replace(thoughts, setThoughts)(await api.reactThought(t.id, emoji)); load(); } catch { pop('Could not send that reaction'); }
  };
  const postThought = async (e) => {
    e.preventDefault();
    setThoughtErr('');
    try { const t = await api.createThought(draft.trim()); setThoughts([t, ...thoughts]); setDraft(''); load(); }
    catch (err) { setThoughtErr(err.body?.text?.[0] || err.body?.detail || 'Could not post.'); }
  };
  const makeTree = async (ids, title) => {
    if (!title) throw new Error('Give your tree a name.');
    const t = await api.createTree(title, ids);
    setTrees((cur) => [t, ...cur]);
    setTreeOpen(false);
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
  const open = (s) => { setSeen((x) => ({ ...x, [s.id]: true })); setViewing(s); };

  const shown = sort === 'top' ? [...thoughts].sort((a, b) => b.total - a.total) : thoughts;

  return (
    <main className="sq">
      <aside className="sq-side">
        <h1 className="sq-title">The Square</h1>
        <button type="button" className="sq-cta sq-cta--side" onClick={() => setComposing(true)}>+ Add status</button>
        <div className="sq-tabs" role="group" aria-label="Sort thoughts">
          <button type="button" aria-pressed={sort === 'new'} onClick={() => setSort('new')}>Newest</button>
          <button type="button" aria-pressed={sort === 'top'} onClick={() => setSort('top')}>Most reacted</button>
        </div>
        <p className="sq-hint">Statuses vanish after 24 hours. Videos are {MAX_VIDEO_SECONDS}s max.</p>
      </aside>

      <section className="sq-main">
        <div className="sq-card">
          <h2>Status updates</h2>
          <div className="sq-rings">
            {!loaded && [0, 1, 2, 3, 4].map((n) => <span key={n} className="sq-skel" aria-hidden="true" />)}
            {loaded && statuses.length === 0 && <p className="sq-hint">No statuses right now. Be the first.</p>}
            {statuses.map((s) => (
              <button key={s.id} type="button" className={`sq-ring${seen[s.id] ? ' sq-ring--seen' : ''}`} onClick={() => open(s)}>
                <i>{s.kind === 'image' ? <img src={s.file} alt="" /> : s.kind === 'video' ? '🎬' : initial(s.user.name)}</i>
                <small className="sq-ring__name">{s.user.id === user?.id ? 'You' : s.user.name}</small>
                <small className="sq-ring__time">{hoursLeft(s.expires_at)}h left</small>
              </button>
            ))}
          </div>
        </div>

        <div className="sq-card">
          <div className="sq-split">
            <h2>Friend trees</h2>
            <button type="button" className="sq-cta" onClick={() => setTreeOpen(true)}>+ New tree</button>
          </div>
          <p className="sq-hint">Only you and the people you tag can see a tree.</p>
          {trees.length === 0 && <p className="sq-hint">No trees yet. Make one and tag your people.</p>}
        </div>
        {trees.map((t) => <Tree key={t.id} tree={t} onLeave={leaveTree} pop={pop} ask={setConfirm}
          onStatus={(st) => { setStatuses((cur) => [st, ...cur]); load(); }} />)}

        <form className="sq-card sq-compose" onSubmit={postThought}>
          <textarea rows={2} maxLength={280} placeholder="What's on your mind?" value={draft}
            aria-label="Share a thought" onChange={(e) => setDraft(e.target.value)} />
          {thoughtErr && <p className="sq-err" role="alert">{thoughtErr}</p>}
          <button type="submit" className="sq-cta" disabled={!draft.trim()}>Share</button>
        </form>

        {shown.map((t) => (
          <article key={t.id} className="sq-card">
            <div className="sq-who"><span className="sq-av">{initial(t.user.name)}</span>
              <div><b>{t.user.name}</b><br /><small>{ago(t.created_at)}</small></div></div>
            <p className="sq-text">{t.text}</p>
            <Reactions mine={t.my_reaction} counts={t.reactions} onPick={(e) => reactThought(t, e)} />
          </article>
        ))}
        {shown.length === 0 && <p className="sq-hint">No thoughts yet. Share the first one.</p>}
      </section>

      <aside className="sq-side">
        <div className="sq-card">
          <h2>🔥 Most liked statuses</h2>
          {trending.statuses.length === 0 && <p className="sq-hint">Nothing yet.</p>}
          <ul>{trending.statuses.map((s) => (
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
      </aside>

      <button type="button" className="sq-fab" aria-label="Add status" onClick={() => setComposing(true)}>＋</button>
      <div className="sq-pops" aria-live="polite">
        {pops.map((p) => (
          <button key={p.id} type="button" className="sq-pop" onClick={() => setPops((c) => c.filter((x) => x.id !== p.id))}>
            <span aria-hidden="true">{/could not/i.test(p.msg) ? '⚠️' : '✨'}</span>{p.msg}
          </button>
        ))}
      </div>
      {treeOpen && (
        <PeoplePicker title="New friend tree" submitLabel="Create tree" askTitle titlePlaceholder="Tree name"
          onSubmit={makeTree} onClose={() => setTreeOpen(false)} />
      )}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      {viewing && <Viewer status={viewing} onClose={() => setViewing(null)} onReact={reactStatus} />}
      {composing && <Composer onClose={() => setComposing(false)} onPosted={(s) => { setStatuses([s, ...statuses]); load(); }} />}
    </main>
  );
}
