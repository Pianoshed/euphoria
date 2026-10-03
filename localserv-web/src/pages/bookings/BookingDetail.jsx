import '../../styles/index.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as bookingsApi from '../../api/bookings';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner, StatusPill, humanizeStatus } from '../../components/ui';
import { isStaff } from '../../utils/permissions';
import { formatPrice } from '../../utils/money';

export default function BookingDetail() {
  usePageBackdrop('cafe');
  const { id } = useParams();
  const { user } = useAuth();
  const [booking, setBooking] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reviewForm, setReviewForm] = useState({ rating: 5, comment: '' });
  const [reviewDone, setReviewDone] = useState(false);

  const load = useCallback(async () => {
    const [b, e] = await Promise.all([bookingsApi.getBooking(id), bookingsApi.listBookingEvents(id)]);
    setBooking(b);
    setEvents(e);
  }, [id]);

  useEffect(() => { load().catch(setError); }, [load]);

  const runAction = (fn) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleReview = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bookingsApi.leaveReview(id, Number(reviewForm.rating), reviewForm.comment);
      setReviewDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (error && !booking) return <div className="page"><ErrorAlert error={error} /></div>;
  if (!booking) return <div className="page"><Spinner /></div>;

  const isCustomer = user.id === booking.customer.id;
  const isProvider = user.id === booking.provider.id;
  const other = isCustomer ? booking.provider : booking.customer;

  return (
    <div className="page page--narrow">
      <div className="card" style={{ marginBottom: 'var(--space-5)' }}>
        <div className="booking-head">
          <div className="min-w-0">
            <h1>{booking.service_title}</h1>
            <div className="booking-head__host">
              <span className="avatar avatar--sm" aria-hidden="true">{other.username[0].toUpperCase()}</span>
              <span className="text-sm muted">
                {isCustomer ? `Hosted by ${other.username}` : `Hanging out with ${other.username}`}
              </span>
            </div>
          </div>
          <StatusPill status={booking.status} />
        </div>

        <div className="booking-price">
          <span className="price" style={{ fontSize: 'var(--text-xl)' }}>{formatPrice(booking.agreed_price)}</span>
        </div>
        {booking.note_from_customer && (
          <p className="quote-note" style={{ marginTop: 'var(--space-3)' }}>&ldquo;{booking.note_from_customer}&rdquo;</p>
        )}
      </div>

      <ErrorAlert error={error} />

      <div className="action-bar">
        {booking.status === 'PENDING' && isProvider && (
          <>
            <button className="btn btn--primary" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'ACCEPTED'))}>I'm in</button>
            <button className="btn btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'DECLINED'))}>Can't make it</button>
          </>
        )}
        {booking.status === 'PENDING' && isCustomer && (
          <button className="btn" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'CANCELLED'))}>Cancel request</button>
        )}
        {booking.status === 'ACCEPTED' && isCustomer && (
          <>
            <button className="btn btn--primary" disabled={busy} onClick={runAction(() => bookingsApi.fundBooking(id))}>
              Lock it in ({formatPrice(booking.agreed_price)})
            </button>
            <button className="btn" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'CANCELLED'))}>Cancel</button>
          </>
        )}
        {booking.status === 'FUNDED' && isProvider && (
          <button className="btn btn--primary" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'IN_PROGRESS'))}>Kick things off</button>
        )}
        {booking.status === 'FUNDED' && isCustomer && (
          <button className="btn btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.refundCancelBooking(id))}>
            Cancel &amp; refund me
          </button>
        )}
        {booking.status === 'IN_PROGRESS' && isProvider && (
          <button className="btn btn--primary" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'COMPLETED'))}>Mark as done</button>
        )}
        {booking.status === 'COMPLETED' && isCustomer && (
          <>
            <button className="btn btn--primary" disabled={busy} onClick={runAction(() => bookingsApi.releaseBookingFunds(id))}>
              Send payment to {other.username}
            </button>
            <button className="btn btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'DISPUTED'))}>
              Something's off
            </button>
          </>
        )}
        {booking.status === 'DISPUTED' && isStaff(user) && (
          <>
            <button className="btn btn--primary" disabled={busy} onClick={runAction(() => bookingsApi.resolveDispute(id, 'RELEASE'))}>
              Resolve: pay host
            </button>
            <button className="btn btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.resolveDispute(id, 'REFUND'))}>
              Resolve: refund guest
            </button>
          </>
        )}
      </div>

      {booking.status === 'COMPLETED' && isCustomer && !reviewDone && (
        <div className="card stack">
          <h3>How was it?</h3>
          <form onSubmit={handleReview} className="stack">
            <div className="field">
              <label htmlFor="rating">Rating</label>
              <select id="rating" className="select" style={{ maxWidth: '10rem' }}
                value={reviewForm.rating} onChange={(e) => setReviewForm((f) => ({ ...f, rating: e.target.value }))}>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? 's' : ''}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="comment">Tell others what to expect (optional)</label>
              <textarea id="comment" className="textarea"
                value={reviewForm.comment} onChange={(e) => setReviewForm((f) => ({ ...f, comment: e.target.value }))} />
            </div>
            <button className="btn btn--primary" disabled={busy} type="submit">Post review</button>
          </form>
        </div>
      )}
      {reviewDone && <p className="alert alert--success">Thanks for sharing — it helps the next person find a good hangout.</p>}

      <hr className="divider" />
      <h3>Timeline</h3>
      <ul className="timeline">
        {events.map((e) => (
          <li key={e.id} className="timeline__item">
            <span className="pill pill--neutral">
              {new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
            <p className="text-sm muted">
              {e.from_status ? `${humanizeStatus(e.from_status)} to ${humanizeStatus(e.to_status)}` : humanizeStatus(e.to_status)}
              {e.actor_username && ` · ${e.actor_username}`}
              {e.note && <> — <em>&ldquo;{e.note}&rdquo;</em></>}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}