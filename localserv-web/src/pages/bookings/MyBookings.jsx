import '../../styles/index.css';
import '../services/plans.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as bookingsApi from '../../api/bookings';
import { ErrorAlert, ChillLoader, Spinner, StatusPill } from '../../components/ui';
import { formatPrice } from '../../utils/money';
import { lookFor } from '../../utils/bubbleLook';

export default function MyBookings() {
  usePageBackdrop('cafe');
  const [role, setRole] = useState('customer');
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setBookings(null);
    bookingsApi.listBookings({ role }).then((data) => setBookings(data.results)).catch(setError);
  }, [role]);

  return (
    <div className="page pl">
      <header className="pl-hero">
        <h1 className="pl-title">Your plans</h1>
        <p className="pl-sub">Plans you've asked to join, and the ones people have asked to join with you.</p>
      </header>
      <div className="pl-tabs" role="group" aria-label="Which plans">
        <button type="button" className={role === 'customer' ? 'active' : ''} aria-pressed={role === 'customer'} onClick={() => setRole('customer')}>Joined</button>
        <button type="button" className={role === 'provider' ? 'active' : ''} aria-pressed={role === 'provider'} onClick={() => setRole('provider')}>Hosting</button>
      </div>
      <ErrorAlert error={error} />
      {!bookings && <ChillLoader kind="plans" />}
      {bookings?.length === 0 && (
        <div className="pl-empty">
          <p>
            {role === 'customer'
              ? 'Nothing on your calendar yet. Go find someone to hang out with.'
              : "No one's joined yet. Your hosted plans will show up here."}
          </p>
          {role === 'customer' && <Link to="/services" className="pl-btn pl-btn--solid">Browse plans</Link>}
        </div>
      )}
      <div className="pl-list">
        {bookings?.map((b) => {
          const other = role === 'customer' ? b.provider : b.customer;
          const look = lookFor(b.id, 0);
          return (
            <Link key={b.id} to={`/bookings/${b.id}`} className="pl-row" style={{ '--tint': look.tint.bg, '--ring': look.tint.ring, '--avatar-shape': look.avatarShape }}>
              <div className="pl-row__main">
                <span className="pl-av" aria-hidden="true">{other.username[0].toUpperCase()}</span>
                <div className="pl-row__text">
                  <strong>{b.service_title}</strong>
                  <small>{role === 'customer' ? `with ${other.username}` : `for ${other.username}`} · {formatPrice(b.agreed_price)}</small>
                </div>
              </div>
              <StatusPill status={b.status} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
