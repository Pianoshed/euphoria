import '../../styles/index.css';
import './plans.css';
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
import { lookFor } from '../../utils/bubbleLook';

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
  const look = lookFor(service.id, 0);

  return (
    <div className="page pl" style={{ '--tint': look.tint.bg, '--ring': look.tint.ring, '--avatar-shape': look.avatarShape }}>
      <header className="pl-hero">
        <div className="pl-hero__row">
          {service.category?.name ? <span className="pl-cat">{service.category.icon ? `${service.category.icon} ` : ''}{service.category.name}</span> : <span />}
          <span className="pl-price">{formatPrice(service.price)}</span>
        </div>
        <h1 className="pl-title">{service.title}</h1>
        <div className="pl-host">
          <span className="pl-av" aria-hidden="true">{service.provider.username[0].toUpperCase()}</span>
          <div>
            <Link to={`/profile/${service.provider.id}`}>{service.provider.username}</Link>
            <small>{service.service_area && <span>📍 {service.service_area}</span>}<StatusPill status={service.status} /></small>
          </div>
        </div>
      </header>

      {service.description && <section className="pl-card"><h2>The plan</h2><p className="pl-desc">{service.description}</p></section>}

      {!isOwnListing && user && (
        <section className="pl-card pl-join" aria-labelledby="join-h">
          <h2 id="join-h">Want in?</h2>
          <p className="pl-note">Send a request. The host says yes or no, then you lock it in.</p>
          <ErrorAlert error={bookingError} />
          <form onSubmit={handleBook} className="pl-form">
            <div className="pl-field">
              <label htmlFor="note">Note for the host (optional)</label>
              <textarea id="note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Anything the host should know before accepting" />
            </div>
            <div className="pl-actions">
              <button className="pl-btn pl-btn--solid" disabled={booking} type="submit">
                {booking ? 'Sending request…' : 'Request to join'}
              </button>
              <button type="button" className="pl-btn" disabled={messaging} onClick={handleMessage}>
                {messaging ? 'Opening…' : '👋 Message host'}
              </button>
            </div>
          </form>
        </section>
      )}
      {isOwnListing && (
        <p className="pl-note">This is your own plan. Manage it from <Link to="/services/mine">Your plans</Link>.</p>
      )}
      {!user && (
        <p className="pl-note"><Link to="/login">Log in</Link> to join this plan.</p>
      )}

      <div className="pl-actions"><ReportButton targetType="SERVICE" targetId={service.id} /></div>

      <section className="pl-card" style={{ marginTop: 14 }}>
        <h2>What people are saying</h2>
        {reviews.length === 0 && <p className="pl-note">No reviews yet. Be the first to share how it went.</p>}
        <div className="pl-reviews">
          {reviews.map((r) => (
            <div key={r.id} className="pl-review">
              <span className="pl-av" aria-hidden="true" style={{ width: 32, height: 32 }}>{r.reviewer_username[0].toUpperCase()}</span>
              <div>
                <p className="row row--wrap text-sm" style={{ margin: '0 0 2px' }}>
                  <StarRating value={r.rating} />
                  <span className="muted">by {r.reviewer_username}</span>
                </p>
                {r.comment && <p className="m-0 break">{r.comment}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
