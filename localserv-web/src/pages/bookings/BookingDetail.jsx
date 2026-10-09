import '../../styles/index.css';
import '../services/plans.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as bookingsApi from '../../api/bookings';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner, StatusPill, humanizeStatus } from '../../components/ui';
import { isStaff } from '../../utils/permissions';
import { formatPrice } from '../../utils/money';
import { lookFor } from '../../utils/bubbleLook';

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

  if (error && !booking) return <div className="page"><ErrorAlert error={error} onRetry={() => window.location.reload()} /></div>;
  if (!booking) return <div className="page"><Spinner /></div>;

  const isCustomer = user.id === booking.customer.id;
  const isProvider = user.id === booking.provider.id;
  const other = isCustomer ? booking.provider : booking.customer;
  const look = lookFor(booking.id, 0);

  return (
    <div className="page pl" style={{ '--tint': look.tint.bg, '--ring': look.tint.ring, '--avatar-shape': look.avatarShape }}>
      <header className="pl-hero">
        <div className="pl-hero__row">
          <h1 className="pl-title">{booking.service_title}</h1>
          <StatusPill status={booking.status} />
        </div>
        <div className="pl-host">
          <span className="pl-av" aria-hidden="true">{other.username[0].toUpperCase()}</span>
          <small>{isCustomer ? `Hosted by ${other.username}` : `Hanging out with ${other.username}`}</small>
          <span className="pl-price" style={{ marginLeft: 'auto' }}>{formatPrice(booking.agreed_price)}</span>
        </div>
        {booking.note_from_customer && <p className="pl-quote">&ldquo;{booking.note_from_customer}&rdquo;</p>}
      </header>

      <ErrorAlert error={error} />

      <div className="pl-actions" style={{ marginBottom: 14 }}>
        {booking.status === 'PENDING' && isProvider && (
          <>
            <button className="pl-btn pl-btn--solid" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'ACCEPTED'))}>I'm in</button>
            <button className="pl-btn pl-btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'DECLINED'))}>Can't make it</button>
          </>
        )}
        {booking.status === 'PENDING' && isCustomer && (
          <button className="pl-btn" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'CANCELLED'))}>Cancel request</button>
        )}
        {booking.status === 'ACCEPTED' && isCustomer && (
          <>
            <button className="pl-btn pl-btn--solid" disabled={busy} onClick={runAction(() => bookingsApi.fundBooking(id))}>
              Lock it in ({formatPrice(booking.agreed_price)})
            </button>
            <button className="pl-btn" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'CANCELLED'))}>Cancel</button>
          </>
        )}
        {booking.status === 'FUNDED' && isProvider && (
          <button className="pl-btn pl-btn--solid" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'IN_PROGRESS'))}>Kick things off</button>
        )}
        {booking.status === 'FUNDED' && isCustomer && (
          <button className="pl-btn pl-btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.refundCancelBooking(id))}>
            Cancel &amp; refund me
          </button>
        )}
        {booking.status === 'IN_PROGRESS' && isProvider && (
          <button className="pl-btn pl-btn--solid" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'COMPLETED'))}>Mark as done</button>
        )}
        {booking.status === 'COMPLETED' && isCustomer && (
          <>
            <button className="pl-btn pl-btn--solid" disabled={busy} onClick={runAction(() => bookingsApi.releaseBookingFunds(id))}>
              Send payment to {other.username}
            </button>
            <button className="pl-btn pl-btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.transitionBooking(id, 'DISPUTED'))}>
              Something's off
            </button>
          </>
        )}
        {booking.status === 'DISPUTED' && isStaff(user) && (
          <>
            <button className="pl-btn pl-btn--solid" disabled={busy} onClick={runAction(() => bookingsApi.resolveDispute(id, 'RELEASE'))}>
              Resolve: pay host
            </button>
            <button className="pl-btn pl-btn--danger" disabled={busy} onClick={runAction(() => bookingsApi.resolveDispute(id, 'REFUND'))}>
              Resolve: refund guest
            </button>
          </>
        )}
      </div>

      {booking.status === 'COMPLETED' && isCustomer && !reviewDone && (
        <div className="pl-card">
          <h3>How was it?</h3>
          <form onSubmit={handleReview} className="pl-form">
            <div className="pl-field">
              <label htmlFor="rating">Rating</label>
              <select id="rating" className="select" style={{ maxWidth: '10rem' }}
                value={reviewForm.rating} onChange={(e) => setReviewForm((f) => ({ ...f, rating: e.target.value }))}>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? 's' : ''}</option>)}
              </select>
            </div>
            <div className="pl-field">
              <label htmlFor="comment">Tell others what to expect (optional)</label>
              <textarea id="comment" className="textarea"
                value={reviewForm.comment} onChange={(e) => setReviewForm((f) => ({ ...f, comment: e.target.value }))} />
            </div>
            <button className="pl-btn pl-btn--solid" disabled={busy} type="submit">Post review</button>
          </form>
        </div>
      )}
      {reviewDone && <p className="alert alert--success">Thanks for sharing — it helps the next person find a good hangout.</p>}

      <section className="pl-card">
      <h3>Timeline</h3>
      <ul className="pl-time">
        {events.map((e) => (
          <li key={e.id}>
            <span className="pill pill--neutral">
              {new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
            <span>
              {e.from_status ? `${humanizeStatus(e.from_status)} to ${humanizeStatus(e.to_status)}` : humanizeStatus(e.to_status)}
              {e.actor_username && ` · ${e.actor_username}`}
              {e.note && <> — <em>&ldquo;{e.note}&rdquo;</em></>}
            </span>
          </li>
        ))}
      </ul>
      </section>
    </div>
  );
}