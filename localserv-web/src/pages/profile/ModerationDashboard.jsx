import '../../styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import * as moderationApi from '../../api/moderation';
import * as accountsApi from '../../api/accounts';
import * as servicesApi from '../../api/services';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner, StatusPill } from '../../components/ui';
import { isStaff } from '../../utils/permissions';

function TargetLabel({ report }) {
  const [label, setLabel] = useState('…');

  useEffect(() => {
    let cancelled = false;
    if (report.target_type === 'USER') {
      accountsApi.getPublicProfile(report.target_id)
        .then((p) => { if (!cancelled) setLabel(`@${p.username}`); })
        .catch(() => { if (!cancelled) setLabel('(user)'); });
    } else if (report.target_type === 'SERVICE') {
      servicesApi.getService(report.target_id)
        .then((s) => { if (!cancelled) setLabel(s.title); })
        .catch(() => { if (!cancelled) setLabel('(listing)'); });
    } else {
      setLabel('(message)');
    }
    return () => { cancelled = true; };
  }, [report.target_type, report.target_id]);

  return <span>{label}</span>;
}

// Maps the small action-picker state to the actual API call -- kept
// as a lookup table rather than an inline ternary so the submit
// handler stays readable.
const ACTION_FNS = {
  suspend: (id, reason) => moderationApi.suspendAccount(id, reason),
  ban: (id, reason) => moderationApi.banAccount(id, reason),
  'suspend-listing': (id, reason) => moderationApi.suspendListing(id, reason),
};

function ReportRow({ report, onResolved }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [showActionFor, setShowActionFor] = useState(null); // 'suspend' | 'ban' | 'suspend-listing' | null

  const runResolve = (resolution) => async () => {
    setBusy(true);
    setError(null);
    try {
      await moderationApi.resolveReport(report.id, resolution, note);
      onResolved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleAccountAction = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ACTION_FNS[showActionFor](report.target_id, actionReason);
      setShowActionFor(null);
      setActionReason('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack-sm">
      <div className="row row--between">
        <p className="m-0 break">
          <strong>{report.target_type}</strong>: <TargetLabel report={report} />
        </p>
        <StatusPill status={report.status} />
      </div>
      <p className="text-sm muted" style={{ margin: 0 }}>
        Reported by @{report.reporter.username} for <strong>{report.reason.replaceAll('_', ' ').toLowerCase()}</strong>
      </p>
      {report.detail && <p className="text-sm m-0 break">&ldquo;{report.detail}&rdquo;</p>}
      <ErrorAlert error={error} />

      {report.status === 'OPEN' && (
        <>
          <div className="row row--wrap">
            {report.target_type === 'USER' && (
              <>
                <button className="btn btn--sm" disabled={busy} onClick={() => setShowActionFor('suspend')}>Suspend user</button>
                <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => setShowActionFor('ban')}>Ban user</button>
              </>
            )}
            {report.target_type === 'SERVICE' && (
              <button className="btn btn--sm" disabled={busy} onClick={() => setShowActionFor('suspend-listing')}>Suspend listing</button>
            )}
          </div>

          {showActionFor && (
            <form onSubmit={handleAccountAction} className="row row--wrap">
              <input className="input" placeholder="Reason (required)" required value={actionReason}
                onChange={(e) => setActionReason(e.target.value)} />
              <button className="btn btn--sm btn--danger" disabled={busy} type="submit">Confirm</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowActionFor(null)}>Cancel</button>
            </form>
          )}

          <div className="row row--wrap" style={{ marginTop: 'var(--space-2)' }}>
            <input className="input" placeholder="Resolution note (optional)" value={note}
              onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn--sm btn--primary" disabled={busy} onClick={runResolve('RESOLVED')}>Resolve</button>
            <button className="btn btn--sm btn--ghost" disabled={busy} onClick={runResolve('DISMISSED')}>Dismiss</button>
          </div>
        </>
      )}
      {report.status !== 'OPEN' && report.resolution_note && (
        <p className="text-sm muted" style={{ margin: 0 }}>Note: {report.resolution_note}</p>
      )}
    </div>
  );
}

export default function ModerationDashboard() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(
    () => moderationApi.listReports({ status: statusFilter }).then((d) => setReports(d.results)).catch(setError),
    [statusFilter]
  );
  useEffect(() => { setReports(null); load(); }, [load]);

  if (!isStaff(user)) {
    return (
      <div className="page">
        <h1>Moderation</h1>
        <p className="muted">This area is only available to staff accounts.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Moderation</h1>
      <div className="tabs">
        {['OPEN', 'RESOLVED', 'DISMISSED'].map((s) => (
          <button key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} onRetry={() => { setError(null); load(); }} />
      {!reports && <Spinner />}
      {reports?.length === 0 && <div className="empty-state"><p>No {statusFilter.toLowerCase()} reports.</p></div>}
      <div className="stack">
        {reports?.map((r) => <ReportRow key={r.id} report={r} onResolved={load} />)}
      </div>
    </div>
  );
}
