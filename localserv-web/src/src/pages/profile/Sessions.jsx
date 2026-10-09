import '../../styles/index.css';
import { useEffect, useState } from 'react';
import * as accountsApi from '../../api/accounts';
import { ErrorAlert, Spinner } from '../../components/ui';

export default function Sessions() {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => accountsApi.listSessions().then(setSessions).catch(setError);
  useEffect(() => { load(); }, []);

  const handleRevoke = async (id) => {
    setBusy(true);
    setError(null);
    try {
      await accountsApi.revokeSession(id);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeAll = async () => {
    setBusy(true);
    setError(null);
    try {
      await accountsApi.revokeAllOtherSessions();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page--narrow">
      <h1>Active sessions</h1>
      <p className="muted">Devices and browsers currently signed in to your account.</p>
      <ErrorAlert error={error} />
      {!sessions && <Spinner />}
      {sessions?.length > 1 && (
        <button className="btn btn--sm" disabled={busy} onClick={handleRevokeAll} style={{ marginBottom: 'var(--space-4)' }}>
          Log out all other devices
        </button>
      )}
      <div className="stack-sm">
        {sessions?.map((s) => (
          <div key={s.id} className="card row row--between">
            <div className="min-w-0">
              <p className="m-0 break">
                {s.user_agent || 'Unknown device'}
                {s.is_current && <span className="pill pill--accent" style={{ marginLeft: 'var(--space-2)' }}>This device</span>}
              </p>
              <p className="text-sm muted m-0">
                {s.ip_address && `${s.ip_address} · `}
                Last active {new Date(s.last_seen_at).toLocaleString()}
              </p>
            </div>
            {!s.is_current && (
              <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => handleRevoke(s.id)}>
                Log out
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
