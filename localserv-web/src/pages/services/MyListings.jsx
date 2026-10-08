import '../../styles/index.css';
import './plans.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as servicesApi from '../../api/services';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, ChillLoader, Spinner, StatusPill } from '../../components/ui';
import { formatPrice } from '../../utils/money';
import { lookFor } from '../../utils/bubbleLook';

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
      <div className="page pl">
        <header className="pl-hero"><h1 className="pl-title">Your plans</h1></header>
        <div className="pl-empty">
          <p>Only host accounts can post plans for people to join. This account is set up for joining plans, not hosting them.</p>
          <Link to="/services" className="pl-btn pl-btn--solid">Browse plans</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page pl">
      <header className="pl-hero">
        <div className="pl-hero__row">
          <h1 className="pl-title">Plans you're hosting</h1>
          <Link to="/services/mine/new" className="pl-btn pl-btn--solid">＋ Post a plan</Link>
        </div>
        <p className="pl-sub">Publish, edit or archive what you've put up for people to join.</p>
      </header>
      <ErrorAlert error={error} />
      {!listings && <ChillLoader kind="plans" />}
      {listings?.length === 0 && (
        <div className="pl-empty">
          <p>Nothing posted yet. Put up a plan and let people find their way to it.</p>
          <Link to="/services/mine/new" className="pl-btn pl-btn--solid">Post your first plan</Link>
        </div>
      )}
      <div className="pl-list">
        {listings?.map((s) => {
          const look = lookFor(s.id, 0);
          return (
            <div key={s.id} className="pl-row" style={{ '--tint': look.tint.bg, '--ring': look.tint.ring }}>
              <div className="pl-row__main">
                <div className="pl-row__text">
                  <strong>{s.title}</strong>
                  <small>{s.category.icon ? `${s.category.icon} ` : ''}{s.category.name} · {formatPrice(s.price)} · <StatusPill status={s.status} /></small>
                </div>
              </div>
              <div className="pl-row__acts">
                <Link to={`/services/${s.id}`} className="pl-btn pl-btn--sm">View</Link>
                <Link to={`/services/mine/${s.id}/edit`} className="pl-btn pl-btn--sm">Edit</Link>
                {NEXT_STATUS[s.status]?.map(([target, label]) => (
                  <button key={target} type="button" className="pl-btn pl-btn--sm pl-btn--solid" disabled={busyId === s.id}
                    onClick={() => handleTransition(s.id, target)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
