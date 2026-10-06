import '../../styles/index.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as bookingsApi from '../../api/bookings';
import { ErrorAlert, ChillLoader, Spinner, StatusPill } from '../../components/ui';
import { formatPrice } from '../../utils/money';

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
    <div className="page">
      <h1>Your plans</h1>
      <div className="tabs">
        <button className={role === 'customer' ? 'active' : ''} onClick={() => setRole('customer')}>Joined</button>
        <button className={role === 'provider' ? 'active' : ''} onClick={() => setRole('provider')}>Hosting</button>
      </div>
      <ErrorAlert error={error} />
      {!bookings && <ChillLoader kind="plans" />}
      {bookings?.length === 0 && (
        <div className="empty-state">
          <p>
            {role === 'customer'
              ? "Nothing on your calendar yet — go find someone to hang out with."
              : "No one's booked in yet — your hosted plans will show up here."}
          </p>
          {role === 'customer' && (
            <Link to="/services" className="btn btn--primary" style={{ marginTop: 'var(--space-3)' }}>
              Browse activities
            </Link>
          )}
        </div>
      )}
      <div className="stack">
        {bookings?.map((b) => {
          const other = role === 'customer' ? b.provider : b.customer;
          return (
            <Link key={b.id} to={`/bookings/${b.id}`} className="card card--link row row--between list-card">
              <div className="list-card__main">
                <span className="avatar avatar--sm" aria-hidden="true">{other.username[0].toUpperCase()}</span>
                <div>
                  <p className="truncate"><strong>{b.service_title}</strong></p>
                  <p className="text-sm muted truncate">
                    {role === 'customer' ? `with ${other.username}` : `for ${other.username}`} · {formatPrice(b.agreed_price)}
                  </p>
                </div>
              </div>
              <span className="list-card__aside"><StatusPill status={b.status} /></span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}