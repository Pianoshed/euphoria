import '../../styles/index.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as servicesApi from '../../api/services';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, Spinner, StatusPill } from '../../components/ui';
import { formatPrice } from '../../utils/money';

const NEXT_STATUS = {
  DRAFT: [['PUBLISHED', 'Publish']],
  PUBLISHED: [['ARCHIVED', 'Archive'], ['DRAFT', 'Unpublish to draft']],
  ARCHIVED: [['DRAFT', 'Move back to draft']],
  SUSPENDED: [], // staff-only to lift; see Django admin
};

export default function MyListings() {
  usePageBackdrop('cafe');
  const { user } = useAuth();
  const [listings, setListings] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => servicesApi.listServices({ mine: true }).then((data) => setListings(data.results)).catch(setError);
  useEffect(() => { load(); }, []);

  const handleTransition = async (id, toStatus) => {
    setBusyId(id);
    setError(null);
    try {
      await servicesApi.transitionService(id, toStatus);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  if (user && user.role !== 'PROVIDER') {
    return (
      <div className="page">
        <h1>Things you're hosting</h1>
        <div className="empty-state">
          <p>Only host accounts can put up activities for people to join. This account is set up for joining plans, not hosting them.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row row--between">
        <h1>Things you're hosting</h1>
        <Link to="/services/mine/new" className="btn btn--primary">Post an activity</Link>
      </div>
      <ErrorAlert error={error} />
      {!listings && <Spinner />}
      {listings?.length === 0 && (
        <div className="empty-state">
          <p>Nothing posted yet — put up an activity and let people find their way to it.</p>
          <Link to="/services/mine/new" className="btn btn--primary" style={{ marginTop: 'var(--space-3)' }}>
            Post your first activity
          </Link>
        </div>
      )}
      <div className="stack">
        {listings?.map((s) => (
          <div key={s.id} className="card listing-card">
            <div className="listing-card__main">
              <p className="listing-card__title"><strong className="break">{s.title}</strong> <StatusPill status={s.status} /></p>
              <p className="text-sm muted">{s.category.name} · {formatPrice(s.price)}</p>
            </div>
            <div className="listing-card__actions">
              <Link to={`/services/${s.id}`} className="btn btn--ghost btn--sm">View</Link>
              <Link to={`/services/mine/${s.id}/edit`} className="btn btn--ghost btn--sm">Edit</Link>
              {NEXT_STATUS[s.status]?.map(([target, label]) => (
                <button key={target} className="btn btn--sm" disabled={busyId === s.id}
                  onClick={() => handleTransition(s.id, target)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
