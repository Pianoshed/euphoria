import '../../styles/index.css';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as accountsApi from '../../api/accounts';
import { ErrorAlert, Spinner } from '../../components/ui';

const DAY = 24 * 60 * 60 * 1000;

// The API may send a plain list or a paged {results: []}.
const asList = (data) => (Array.isArray(data) ? data : data?.results ?? []);

// The API sends the blocked person's user id as `id`.
const personId = (b) => b.id;

function windowText(b) {
  if (!b.can_unblock) return 'This block is now permanent.';
  if (!b.unblock_until) return null;
  const until = new Date(b.unblock_until);
  if (Number.isNaN(until.getTime())) return null;
  const days = Math.max(0, Math.ceil((until.getTime() - Date.now()) / DAY));
  const when = until.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (days <= 1) return `Last day to unblock (until ${when}). After that it becomes permanent.`;
  return `${days} days left to unblock (until ${when}). After that it becomes permanent.`;
}

export default function BlockedPeople() {
  const [blocks, setBlocks] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => accountsApi.listBlocks().then((d) => setBlocks(asList(d))).catch(setError);
  useEffect(() => { load(); }, []);

  const handleUnblock = async (b) => {
    setBusyId(personId(b));
    setError(null);
    try {
      await accountsApi.unblockUser(personId(b));
      await load();
    } catch (err) {
      setError(err);
      load(); // the window may have just closed: refresh so the row shows the real state
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page page--narrow">
      <h1>Blocked people</h1>
      <p className="muted">
        You can unblock someone for 6 months after blocking them, and your chat comes back with all its old
        messages. After that the block is permanent.
      </p>
      <ErrorAlert error={error} />
      {!blocks && !error && <Spinner />}
      {blocks?.length === 0 && <p className="muted text-sm">You haven't blocked anyone.</p>}
      <div className="stack-sm">
        {blocks?.map((b) => {
          const id = personId(b);
          const name = b.display_name || b.username || 'Someone';
          const note = windowText(b);
          return (
            <div key={id} className="card row row--between">
              <div className="min-w-0">
                <p className="m-0 break">
                  {name}
                  {!b.can_unblock && <span className="pill pill--neutral" style={{ marginLeft: 'var(--space-2)' }}>Permanent</span>}
                </p>
                {note && <p className="text-sm muted m-0">{note}</p>}
              </div>
              {b.can_unblock && (
                <button className="btn btn--sm" disabled={busyId === id} onClick={() => handleUnblock(b)}>
                  {busyId === id ? 'Unblocking…' : 'Unblock'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ marginTop: 'var(--space-4)' }}><Link to="/profile/me">Back to my profile</Link></p>
    </div>
  );
}
