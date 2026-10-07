import { useCallback, useEffect, useRef, useState } from 'react';
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

function Viewer({ status, onClose, onReact }) {
  const isVideo = status.kind === 'video';
  const ms = isVideo ? Math.min(status.duration || MAX_VIDEO_SECONDS, MAX_VIDEO_SECONDS) * 1000 : 6000;
  useEffect(() => {
    const t = setTimeout(onClose, ms + 300);
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => { clearTimeout(t); window.removeEventListener('keydown', key); };
  }, [status.id, ms, onClose]);
  return (
    <div className="sq-viewer" role="dialog" aria-modal="true" aria-label={`${status.user.name}'s status`}>
      <div className="sq-stage">
        <div className="sq-bar"><span key={status.id} style={{ animationDuration: `${ms}ms` }} /></div>
        <div className="sq-vhead">
          <b>{status.user.name} · {hoursLeft(status.expires_at)}h left</b>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {status.kind === 'image' && <img src={status.file} alt="" />}
        {isVideo && <video src={status.file} autoPlay playsInline controls={false} onEnded={onClose} />}
        {status.kind === 'text' && <p className="sq-big">{status.text}</p>}
        {status.kind !== 'text' && status.text && <p className="sq-cap">{status.text}</p>}
        <div className="sq-vfoot"><Reactions mine={status.my_reaction} onPick={(e) => onReact(status, e)} /></div>
      </div>
    </div>
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

function Tree({ tree, onLeave, onStatus, pop }) {
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
  const asStatus = async () => {
    if (!window.confirm('Post this tree as a status? Everyone on the Square can see it for 24 hours.')) return;
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
  const submit = async () => {
    setErr('');
    if (!file && !text.trim()) return setErr('Add a photo, a video or some text.');
    try {
      const fd = new FormData();
      fd.append('text', text.trim());
      if (file?.type.startsWith('image/')) {
        setBusy('Shrinking photo…');
        fd.append('file', await shrinkImage(file), 'status.jpg');
      } else if (file?.type.startsWith('video/')) {
        setBusy(`Trimming video (up to ${MAX_VIDEO_SECONDS}s)…`);
        const { blob, duration } = await shrinkVideo(file);
        fd.append('file', blob, 'status.webm');
        fd.append('duration', String(duration));
      } else if (file) return setErr('Choose a photo or a video.');
      setBusy('Posting…');
      onPosted(await api.createStatus(fd));
      onClose();
    } catch (e) {
      setErr(e.body?.file?.[0] || e.body?.detail || e.message || 'Could not post. Try again.');
      setBusy('');
    }
  };
  return (
    <div className="sq-viewer" role="dialog" aria-modal="true" aria-label="New status">
      <div className="sq-sheet">
        <h2>New status</h2>
        <input type="text" maxLength={140} placeholder="Say something (optional)" value={text}
          onChange={(e) => setText(e.target.value)} />
        <input type="file" accept="image/*,video/*" onChange={(e) => setFile(e.target.files[0] || null)} />
        <p className="sq-hint">Photos are shrunk before upload. Videos are cut to {MAX_VIDEO_SECONDS} seconds. Statuses disappear after 24 hours.</p>
        {err && <p className="sq-err" role="alert">{err}</p>}
        <div className="sq-row">
          <button type="button" className="sq-cta" disabled={!!busy} onClick={submit}>{busy || 'Post for 24 hours'}</button>
          <button type="button" className="sq-ghost" disabled={!!busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
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
  const leaveTree = async (t) => {
    if (!window.confirm(t.mine ? 'Delete this tree for everyone?' : 'Leave this tree?')) return;
    try { await api.removeTree(t.id); setTrees((cur) => cur.filter((x) => x.id !== t.id)); }
    catch { pop('Could not do that'); }
  };
  const open = (s) => { setSeen((x) => ({ ...x, [s.id]: true })); setViewing(s); };

  const shown = sort === 'top' ? [...thoughts].sort((a, b) => b.total - a.total) : thoughts;

  return (
    <main className="sq">
      <aside className="sq-side">
        <h1 className="sq-title">The Square</h1>
        <button type="button" className="sq-cta" onClick={() => setComposing(true)}>+ Add status</button>
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
            {statuses.length === 0 && <p className="sq-hint">No statuses right now. Be the first.</p>}
            {statuses.map((s) => (
              <button key={s.id} type="button" className={`sq-ring${seen[s.id] ? ' sq-ring--seen' : ''}`} onClick={() => open(s)}>
                <i>{s.kind === 'image' ? <img src={s.file} alt="" /> : s.kind === 'video' ? '🎬' : initial(s.user.name)}</i>
                <small>{s.user.id === user?.id ? 'You' : s.user.name}</small>
                <small>{hoursLeft(s.expires_at)}h left</small>
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
        {trees.map((t) => <Tree key={t.id} tree={t} onLeave={leaveTree} pop={pop}
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
            <li key={s.id}><button type="button" onClick={() => open(s)}>{s.user.name}: {s.text || (s.kind === 'video' ? 'Video' : 'Photo')}</button><b>❤️ {s.likes}</b></li>
          ))}</ul>
        </div>
        <div className="sq-card">
          <h2>💬 Trending thoughts</h2>
          {trending.thoughts.length === 0 && <p className="sq-hint">Nothing yet.</p>}
          <ul>{trending.thoughts.map((t) => (
            <li key={t.id}><span>{t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text}</span><b>{t.total}</b></li>
          ))}</ul>
        </div>
        <div className="sq-card">
          <h2>Emoji right now</h2>
          <p className="sq-emoji">{trending.emoji.join(' ') || '—'}</p>
        </div>
      </aside>

      <div className="sq-pops" aria-live="polite">{pops.map((p) => <div key={p.id} className="sq-pop">{p.msg}</div>)}</div>
      {treeOpen && (
        <PeoplePicker title="New friend tree" submitLabel="Create tree" askTitle titlePlaceholder="Tree name"
          onSubmit={makeTree} onClose={() => setTreeOpen(false)} />
      )}
      {viewing && <Viewer status={viewing} onClose={() => setViewing(null)} onReact={reactStatus} />}
      {composing && <Composer onClose={() => setComposing(false)} onPosted={(s) => { setStatuses([s, ...statuses]); load(); }} />}
    </main>
  );
}
