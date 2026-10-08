import '../../styles/index.css';
import './callLog.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

const MISSED = new Set(['no_answer', 'busy', 'cancelled']);
const OUTCOME_ICON = { completed: '✅', no_answer: '📵', busy: '⏳', cancelled: '📵', declined: '🚫', failed: '⚠️', ringing: '🔔', in_progress: '🟢' };
const FILTERS = [['all', 'All'], ['missed', 'Missed'], ['in', 'Incoming'], ['out', 'Outgoing']];
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toDateString();
function dayLabel(iso) {
  const d = new Date(iso);
  const diff = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const TINTS = ['#fff0b8', '#ffe3dd', '#ece7ff', '#dcf7ea', '#dff0ff'];
const tintOf = (id) => TINTS[Math.abs(Number(id) || String(id).length) % TINTS.length];

export default function CallLog() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [msgBusy, setMsgBusy] = useState(null);
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

  const isMissedForMe = useCallback((r) => r.callee === user.id && MISSED.has(r.outcome), [user.id]);
  const missedCount = useMemo(() => (rows || []).filter(isMissedForMe).length, [rows, isMissedForMe]);

  // Filter + search, then fold runs of identical calls with one person into a single entry ("x3").
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || []).filter((r) => {
      const outgoing = r.caller === user.id;
      if (filter === 'missed' && !isMissedForMe(r)) return false;
      if (filter === 'in' && outgoing) return false;
      if (filter === 'out' && !outgoing) return false;
      if (!q) return true;
      return `${r.caller_username || ''} ${r.callee_username || ''}`.toLowerCase().includes(q);
    });
  }, [rows, filter, query, user.id, isMissedForMe]);

  const groups = useMemo(() => {
    const days = [];
    visible.forEach((r) => {
      const outgoing = r.caller === user.id;
      const otherId = outgoing ? r.callee : r.caller;
      const key = dayKey(r.started_at);
      let day = days[days.length - 1];
      if (!day || day.key !== key) { day = { key, label: dayLabel(r.started_at), items: [] }; days.push(day); }
      const last = day.items[day.items.length - 1];
      if (scope !== 'all' && last && last.otherId === otherId && last.outgoing === outgoing && last.row.outcome === r.outcome && last.row.mode === r.mode) {
        last.count += 1; last.secs += durationSeconds(r); last.earlier = r.started_at;
      } else {
        day.items.push({ row: r, outgoing, otherId, count: 1, secs: durationSeconds(r), earlier: r.started_at });
      }
    });
    return days;
  }, [visible, user.id, scope]);

  const message = async (otherId) => {
    setMsgBusy(otherId);
    try { const c = await chatApi.startConversation(otherId); navigate(`/chat/${c.id}`); } catch (err) { setError(err); } finally { setMsgBusy(null); }
  };

  return (
    <div className="page calllog">
      <header className="calllog__head">
        <div>
          <h1>Call log</h1>
          <p className="muted">Every voice and video call, with the time it started and how long it lasted.</p>
        </div>
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
            {missedCount > 0 && <div className="card calllog__stat--missed"><strong>{missedCount}</strong><span>missed</span></div>}
            <div className="card"><strong>{formatDuration(totals.seconds)}</strong><span>total talk time</span></div>
          </div>


          <div className="calllog__tools">
            <input type="search" className="calllog__search" placeholder="Search by name…" aria-label="Search calls by name"
              value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="calllog__chips" role="group" aria-label="Filter calls">
              {FILTERS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filter === key} className={filter === key ? 'is-on' : ''} onClick={() => setFilter(key)}>
                  {label}{key === 'missed' && missedCount > 0 && <b>{missedCount}</b>}
                </button>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="card calllog__empty">
              <p><strong>No calls yet.</strong></p>
              <p className="muted">Start a voice or video call from any conversation and it will show up here.</p>
              <Link to="/chat" className="btn btn--primary btn--sm">Go to messages</Link>
            </div>
          ) : (
            <>
            {visible.length === 0 && <div className="card calllog__empty"><p className="muted">No calls match that. Try another filter.</p></div>}
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
                  {visible.map((r) => {
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

            {/* Phones: grouped by day, one card per person, with quick actions */}
            <div className="calllog__m">
              {groups.map((day) => (
                <section key={day.key} className="calllog__day" aria-label={day.label}>
                  <h2>{day.label}<small>{day.items.reduce((n, i) => n + i.count, 0)}</small></h2>
                  {day.items.map((it) => {
                    const r = it.row;
                    const missed = isMissedForMe(r);
                    const name = scope === 'all'
                      ? `${nameOf(r.caller, r.caller_username)} → ${nameOf(r.callee, r.callee_username)}`
                      : nameOf(it.outgoing ? r.callee : r.caller, it.outgoing ? r.callee_username : r.caller_username);
                    const label = (RESULT_LABEL[r.outcome] || [r.outcome, r.outcome])[it.outgoing || scope === 'all' ? 0 : 1];
                    return (
                      <article key={r.id} className={`calllog__card${missed ? ' is-missed' : ''}`} style={{ '--t': tintOf(it.otherId) }}>
                        <span className="calllog__av" aria-hidden="true">{(name[0] || '?').toUpperCase()}<i>{OUTCOME_ICON[r.outcome] || '📞'}</i></span>
                        <div className="calllog__info">
                          <strong>{name}{it.count > 1 && <em>×{it.count}</em>}</strong>
                          <small>
                            <span aria-hidden="true">{it.outgoing ? '↗' : '↙'}</span>
                            <span className="sr-only">{it.outgoing ? 'Outgoing' : 'Incoming'}</span>
                            {r.mode === 'voice' ? ' Voice' : ' Video'} · {clock(it.count > 1 ? it.earlier : r.started_at)}{it.count > 1 ? `–${clock(r.started_at)}` : ''}
                            {it.secs > 0 && <> · {formatDuration(it.secs)}</>}
                          </small>
                          <span className={`pill pill--${missed ? 'danger' : (RESULT_TONE[r.outcome] || 'neutral')}`}>{label}</span>
                        </div>
                        {scope !== 'all' && (
                          <div className="calllog__acts">
                            <button type="button" className="calllog__act" disabled={msgBusy === it.otherId} onClick={() => message(it.otherId)} aria-label={`Message ${name}`}>💬</button>
                            <Link to={`/profile/${it.otherId}`} className="calllog__act" aria-label={`View ${name}'s profile`}>👤</Link>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </section>
              ))}
            </div>
            </>
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
