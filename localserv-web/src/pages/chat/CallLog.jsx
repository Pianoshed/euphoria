import '../../styles/index.css';
import './callLog.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as chatApi from '../../api/chat';
import { useAuth } from '../../context/AuthContext';
import { isStaff } from '../../utils/permissions';
import { ErrorAlert, Spinner } from '../../components/ui';

/*
 * Call log: who called whom, when, and for how many minutes.
 *   "My calls"  - calls you made or received.
 *   "All calls" - staff only, the audit view of every call on the site (the server enforces this).
 * The server records the calls itself (apps/chat/call_logs.py); this page only reads them.
 */

const RESULT_LABEL = {
  // outcome: [shown to the caller, shown to the person called]
  completed: ['Answered', 'Answered'],
  no_answer: ['No answer', 'Missed'],
  declined: ['Declined', 'You declined'],
  busy: ['Busy', 'Missed'],
  cancelled: ['Cancelled', 'Missed'],
  failed: ['Failed', 'Failed'],
  ringing: ['Ringing', 'Ringing'],
  in_progress: ['In progress', 'In progress'],
};
const RESULT_TONE = { completed: 'success', in_progress: 'accent', ringing: 'accent', declined: 'danger', failed: 'danger' };

export function durationSeconds(row) {
  if (typeof row.duration_seconds === 'number') return row.duration_seconds;
  if (row.answered_at && row.ended_at) {
    return Math.max(0, Math.round((new Date(row.ended_at) - new Date(row.answered_at)) / 1000));
  }
  return 0;
}

// 0 -> "—", 45 -> "45 s", 200 -> "3 min 20 s", 4000 -> "1 h 6 min"
export function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (s <= 0) return '\u2014';
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

const when = (iso) => new Date(iso).toLocaleString([], {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

function downloadCsv(rows, nameOf) {
  const header = ['Started', 'Caller', 'Called', 'Type', 'Result', 'Answered at', 'Ended at', 'Duration (seconds)', 'Duration (minutes)'];
  const lines = rows.map((r) => {
    const secs = durationSeconds(r);
    return [
      r.started_at, nameOf(r.caller, r.caller_username), nameOf(r.callee, r.callee_username), r.mode,
      r.outcome, r.answered_at || '', r.ended_at || '', secs, (secs / 60).toFixed(2),
    ].map(csvCell).join(',');
  });
  const blob = new Blob([`\uFEFF${[header.map(csvCell).join(','), ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `call-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CallLog() {
  const { user } = useAuth();
  const staff = isStaff(user);
  const [scope, setScope] = useState('mine'); // 'mine' | 'all'
  const [rows, setRows] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const nameOf = useCallback(
    (id, username) => (id === user.id ? 'You' : (username || 'Unknown user')),
    [user.id],
  );

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    setPage(1);
    chatApi.listCallLogs({ scope, page: 1 })
      .then((data) => {
        if (cancelled) return;
        setRows(data.results ?? data);
        setHasMore(Boolean(data.next));
      })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [scope]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await chatApi.listCallLogs({ scope, page: page + 1 });
      setRows((prev) => [...(prev || []), ...(data.results ?? data)]);
      setPage((p) => p + 1);
      setHasMore(Boolean(data.next));
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const totals = useMemo(() => {
    const list = rows || [];
    const answered = list.filter((r) => durationSeconds(r) > 0);
    return {
      calls: list.length,
      answered: answered.length,
      seconds: answered.reduce((sum, r) => sum + durationSeconds(r), 0),
    };
  }, [rows]);

  return (
    <div className="page calllog">
      <header className="calllog__head">
        <div>
          <h1>Call log</h1>
          <p className="muted">Every voice and video call, with the time it started and how long it lasted.</p>
        </div>
        {rows?.length > 0 && (
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv(rows, nameOf)}>
            Download CSV
          </button>
        )}
      </header>

      {staff && (
        <div className="tabs" role="group" aria-label="Which calls to show">
          <button type="button" className={scope === 'mine' ? 'active' : undefined} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>My calls</button>
          <button type="button" className={scope === 'all' ? 'active' : undefined} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All calls (audit)</button>
        </div>
      )}

      <ErrorAlert error={error} />
      {!rows && !error && <Spinner />}

      {rows && (
        <>
          <div className="calllog__stats">
            <div className="card"><strong>{totals.calls}</strong><span>calls{hasMore ? ' loaded' : ''}</span></div>
            <div className="card"><strong>{totals.answered}</strong><span>answered</span></div>
            <div className="card"><strong>{formatDuration(totals.seconds)}</strong><span>total talk time</span></div>
          </div>

          {rows.length === 0 ? (
            <div className="card calllog__empty">
              <p><strong>No calls yet.</strong></p>
              <p className="muted">Start a voice or video call from any conversation and it will show up here.</p>
              <Link to="/chat" className="btn btn--primary btn--sm">Go to messages</Link>
            </div>
          ) : (
            <div className="calllog__scroll">
              <table className="calllog__table">
                <thead>
                  <tr>
                    <th scope="col">Date and time</th>
                    <th scope="col">{scope === 'all' ? 'Caller \u2192 Called' : 'With'}</th>
                    <th scope="col">Type</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="calllog__num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const outgoing = r.caller === user.id;
                    const secs = durationSeconds(r);
                    const label = (RESULT_LABEL[r.outcome] || [r.outcome, r.outcome])[outgoing || scope === 'all' ? 0 : 1];
                    return (
                      <tr key={r.id}>
                        <td data-label="Date and time">{when(r.started_at)}</td>
                        <td data-label={scope === 'all' ? 'Caller \u2192 Called' : 'With'}>
                          {scope === 'all' ? (
                            <>{nameOf(r.caller, r.caller_username)} <span aria-hidden="true">{'\u2192'}</span><span className="sr-only"> called </span> {nameOf(r.callee, r.callee_username)}</>
                          ) : (
                            <>
                              <span className="calllog__dir" aria-hidden="true">{outgoing ? '\u2197' : '\u2199'}</span>
                              <span className="sr-only">{outgoing ? 'Outgoing to ' : 'Incoming from '}</span>
                              {outgoing ? nameOf(r.callee, r.callee_username) : nameOf(r.caller, r.caller_username)}
                            </>
                          )}
                        </td>
                        <td data-label="Type">{r.mode === 'voice' ? 'Voice' : 'Video'}</td>
                        <td data-label="Result"><span className={`pill pill--${RESULT_TONE[r.outcome] || 'neutral'}`}>{label}</span></td>
                        <td data-label="Duration" className="calllog__num">{formatDuration(secs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {hasMore && (
            <button type="button" className="btn btn--sm calllog__more" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading\u2026' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
