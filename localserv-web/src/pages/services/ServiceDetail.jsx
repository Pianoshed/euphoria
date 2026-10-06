import '../../styles/index.css';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as servicesApi from '../../api/services';
import * as bookingsApi from '../../api/bookings';
import * as chatApi from '../../api/chat';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner, StatusPill } from '../../components/ui';
import { ReportButton } from '../../components/ReportButton';
import { StarRating } from '../../components/icons';
import { formatPrice } from '../../utils/money';

export default function ServiceDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [service, setService] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState(null);
  const [messaging, setMessaging] = useState(false);

  useEffect(() => {
    servicesApi.getService(id).then(setService).catch(setError);
    servicesApi.listServiceReviews(id).then(setReviews).catch(() => {});
  }, [id]);

  const handleBook = async (e) => {
    e.preventDefault();
    setBookingError(null);
    setBooking(true);
    try {
      const created = await bookingsApi.createBooking({ service_id: id, note_from_customer: note });
      navigate(`/bookings/${created.id}`);
    } catch (err) {
      setBookingError(err);
    } finally {
      setBooking(false);
    }
  };

  const handleMessage = async () => {
    setMessaging(true);
    try {
      const conversation = await chatApi.startConversation(service.provider.id);
      navigate(`/chat/${conversation.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setMessaging(false);
    }
  };

  if (error) return <div className="page"><ErrorAlert error={error} /></div>;
  if (!service) return <div className="page"><Spinner /></div>;

  const isOwnListing = user && user.id === service.provider.id;

  return (
    <div className="page page--narrow">
      {service.category?.name && <span className="pill pill--accent">{service.category.icon ? `${service.category.icon} ` : ''}{service.category.name}</span>}
      <h1 className="break" style={{ marginTop: 'var(--space-3)' }}>{service.title}</h1>

      <div className="e-detail-head">
        <span className="avatar" aria-hidden="true">{service.provider.username[0].toUpperCase()}</span>
        <div className="e-detail-host">
          <Link to={`/profile/${service.provider.id}`}>{service.provider.username}</Link>
          <span>
            {service.service_area && `${service.service_area} · `}
            <StatusPill status={service.status} />
          </span>
        </div>
      </div>

      <p className="price" style={{ fontSize: 'var(--text-xl)' }}>{formatPrice(service.price)}</p>
      <p className="break">{service.description}</p>

      {!isOwnListing && user && (
        <div className="card stack e-book-card">
          <h3>Want in?</h3>
          <ErrorAlert error={bookingError} />
          <form onSubmit={handleBook} className="stack">
            <div className="field">
              <label htmlFor="note">Note for the host (optional)</label>
              <textarea id="note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Anything the host should know before accepting" />
            </div>
            <div className="row row--wrap stack-mobile">
              <button className="btn btn--primary" disabled={booking} type="submit">
                {booking ? 'Sending request…' : 'Request to join'}
              </button>
              <button type="button" className="btn btn--ghost" disabled={messaging} onClick={handleMessage}>
                {messaging ? 'Opening…' : 'Message host'}
              </button>
            </div>
          </form>
        </div>
      )}
      {isOwnListing && (
        <p className="text-sm muted">This is your own activity — manage it from <Link to="/services/mine">Things you're hosting</Link>.</p>
      )}
      {!user && (
        <p className="text-sm muted"><Link to="/login">Log in</Link> to join this activity.</p>
      )}

      <div className="row" style={{ marginTop: 'var(--space-3)' }}>
        <ReportButton targetType="SERVICE" targetId={service.id} />
      </div>

      <hr className="divider" />
      <h3>What people are saying</h3>
      {reviews.length === 0 && <p className="muted text-sm">No reviews yet — be the first to share how it went.</p>}
      <div className="stack">
        {reviews.map((r) => (
          <div key={r.id} className="card e-review">
            <span className="avatar avatar--sm" aria-hidden="true">{r.reviewer_username[0].toUpperCase()}</span>
            <div className="e-review__body">
              <p className="row row--wrap text-sm" style={{ marginBottom: '0.2rem' }}>
                <StarRating value={r.rating} />
                <span className="muted">by {r.reviewer_username}</span>
              </p>
              {r.comment && <p className="m-0 break">{r.comment}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
