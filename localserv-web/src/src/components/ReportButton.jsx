import { useState } from 'react';
import * as moderationApi from '../api/moderation';
import { ErrorAlert } from './ui';

const REASONS = [
  ['SPAM', 'Spam'],
  ['HARASSMENT', 'Harassment or abuse'],
  ['FRAUD', 'Fraud or scam'],
  ['PROHIBITED_CONTENT', 'Prohibited content'],
  ['IMPERSONATION', 'Impersonation'],
  ['OTHER', 'Other'],
];

export function ReportButton({ targetType, targetId }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('SPAM');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return <p className="text-sm muted m-0" role="status">Report sent. Thanks for flagging it.</p>;
  }

  if (!open) {
    return <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>Report</button>;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await moderationApi.fileReport(targetType, targetId, reason, detail);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card stack-sm report-form">
      <ErrorAlert error={error} />
      <div className="field">
        <label htmlFor={`reason-${targetId}`}>Reason</label>
        <select id={`reason-${targetId}`} className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`detail-${targetId}`}>Details (optional)</label>
        <textarea id={`detail-${targetId}`} className="textarea" maxLength={1000}
          value={detail} onChange={(e) => setDetail(e.target.value)} />
      </div>
      <div className="row row--wrap">
        <button className="btn btn--danger btn--sm" disabled={submitting} type="submit">
          {submitting ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
