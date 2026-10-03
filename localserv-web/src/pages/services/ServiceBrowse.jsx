import '../../styles/index.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as servicesApi from '../../api/services';
import { ErrorAlert, Spinner } from '../../components/ui';
import { formatPrice } from '../../utils/money';

export default function ServiceBrowse() {
  usePageBackdrop('cafe');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const categoryId = params.get('category_id') || '';

  const [categories, setCategories] = useState([]);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Typing updates local state immediately; the URL (and the request) follow 300ms later,
  // so a phone on a slow connection isn't firing a fetch per keystroke.
  const [search, setSearch] = useState(q);
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    if (search === q) return undefined;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search) next.set('q', search); else next.delete('q');
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, q, params, setParams]);

  useEffect(() => {
    servicesApi.listCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    servicesApi.listServices({ q, category_id: categoryId || undefined })
      .then((data) => { if (!cancelled) setResults(data.results); })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; }; // ignore out-of-order responses
  }, [q, categoryId]);

  const toggleCategory = (id) => {
    const next = new URLSearchParams(params);
    if (categoryId === id) next.delete('category_id'); else next.set('category_id', id);
    setParams(next);
  };

  return (
    <div className="page">
      <div className="e-browse-head">
        <h1>Find a plan near you</h1>
        <p>Browse what people are hosting this week, or narrow it down by category.</p>
      </div>

      <div className="e-browse-filters">
        <input
          type="search"
          className="input"
          aria-label="Search activities"
          placeholder="Search activities…"
          enterKeyHint="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {categories.length > 0 && (
          <div className="e-chip-row">
            {categories.map((c) => (
              <button
                key={c.id}
                className={categoryId === c.id ? 'active' : ''}
                aria-pressed={categoryId === c.id}
                onClick={() => toggleCategory(c.id)}
                type="button"
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <ErrorAlert error={error} />
      {loading && <Spinner />}
      {!loading && results?.length === 0 && (
        <div className="empty-state">
          <p>Nothing matches yet. Try a different category, or be the first to post one.</p>
        </div>
      )}

      <div className="grid">
        {results?.map((service) => (
          <Link key={service.id} to={`/services/${service.id}`} className="card card--link stack-sm">
            <div className="e-service-card__top">
              {service.category?.name && <span className="pill pill--accent">{service.category.name}</span>}
              <span className="price">{formatPrice(service.price)}</span>
            </div>
            <h3 className="m-0 break">{service.title}</h3>
            <div className="e-service-card__host">
              <span className="avatar avatar--sm" aria-hidden="true">{service.provider.username[0].toUpperCase()}</span>
              <span>Hosted by {service.provider.username}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
