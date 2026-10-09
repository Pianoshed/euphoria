import '../../styles/index.css';
import '../home-feed.css'; // shared night-scene backdrop
import './browse.css';
import { usePageBackdrop } from '../../hooks/usePageBackdrop';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as servicesApi from '../../api/services';
import * as chatApi from '../../api/chat';
import { useAuth } from '../../context/AuthContext';
import { ErrorAlert, ChillLoader, Spinner } from '../../components/ui';
import { formatPrice } from '../../utils/money';
import { lookFor } from '../../utils/bubbleLook';
import { Icon } from '../../components/icons';

const SORTS = [
  { value: 'new', label: 'Newest' },
  { value: 'low', label: 'Price: low to high' },
  { value: 'high', label: 'Price: high to low' },
];
const PRICES = [
  { value: 'any', label: 'Any price' },
  { value: 'free', label: 'Free' },
  { value: '5000', label: 'Under ₦5,000' },
  { value: '20000', label: 'Under ₦20,000' },
];
const pageSizeNow = () => (window.matchMedia('(max-width: 720px)').matches ? 8 : 12);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const initial = (s) => (s || '?').charAt(0).toUpperCase();

export default function ServiceBrowse() {
  usePageBackdrop('scene'); // same artwork as the home page
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const categoryId = params.get('category_id') || '';

  const [categories, setCategories] = useState([]);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('new');
  const [price, setPrice] = useState('any');
  const [page, setPage] = useState(0);
  const [pageSize] = useState(pageSizeNow);
  const [drawer, setDrawer] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [messaging, setMessaging] = useState(false);
  const [popupError, setPopupError] = useState(null);
  const lastTrigger = useRef(null);
  const closeRef = useRef(null);

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

  useEffect(() => { setPage(0); }, [q, categoryId, sort, price]);

  const pickCategory = (id) => {
    const next = new URLSearchParams(params);
    if (!id || categoryId === id) next.delete('category_id'); else next.set('category_id', id);
    setParams(next);
  };
  const reset = () => { setSort('new'); setPrice('any'); pickCategory(''); };
  const activeFilters = (categoryId ? 1 : 0) + (price !== 'any' ? 1 : 0);

  // price + sort run on the loaded list
  const list = useMemo(() => {
    let out = results || [];
    if (price === 'free') out = out.filter((s) => num(s.price) === 0);
    else if (price !== 'any') out = out.filter((s) => num(s.price) <= Number(price));
    if (sort === 'low') out = [...out].sort((a, b) => num(a.price) - num(b.price));
    if (sort === 'high') out = [...out].sort((a, b) => num(b.price) - num(a.price));
    return out;
  }, [results, price, sort]);

  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const shown = useMemo(() => list.slice(safePage * pageSize, (safePage + 1) * pageSize), [list, safePage, pageSize]);
  const looks = useMemo(() => Object.fromEntries((results || []).map((s) => [s.id, lookFor(s.id, 0)])), [results]);

  // Filter drawer (phones): scroll lock + Escape.
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [drawer]);

  // Quick-view modal: Escape closes, page behind doesn't scroll, focus returns to the card.
  const openService = (id, el) => { lastTrigger.current = el; setPopupError(null); setOpenId(id); };
  const closeService = () => { setOpenId(null); lastTrigger.current?.focus?.(); };
  useEffect(() => {
    if (!openId) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') closeService(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(() => {
    const s = results?.find((r) => r.id === openId);
    return s ? { s, look: looks[s.id] } : null;
  }, [results, openId, looks]);

  const messageHost = async (service) => {
    setMessaging(true);
    setPopupError(null);
    try {
      const conversation = await chatApi.startConversation(service.provider.id);
      navigate(`/chat/${conversation.id}`);
    } catch (err) {
      setPopupError(err);
    } finally {
      setMessaging(false);
    }
  };

  const catLabel = (c) => c.name;

  return (
    <div className="page sb">
      <header className="sb-hero">
        <div className="sb-head">
          <div>
            <h1 className="sb-title">Find a plan near you</h1>
            <p className="sb-sub">Browse what people are hosting this week, or narrow it down by category.</p>
          </div>
          <button type="button" className="sb-filterbtn" onClick={() => setDrawer(true)} aria-haspopup="dialog">
            <Icon name="sliders" size={16} /> Filters{activeFilters > 0 && <b>{activeFilters}</b>}
          </button>
        </div>
        <input
          type="search"
          className="sb-search"
          aria-label="Search activities"
          placeholder="Search activities…"
          enterKeyHint="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {categories.length > 0 && (
          <div className="sb-chips" role="group" aria-label="Categories">
            <button type="button" aria-pressed={!categoryId} onClick={() => pickCategory('')}>All</button>
            {categories.map((c) => (
              <button key={c.id} type="button" aria-pressed={categoryId === c.id} onClick={() => pickCategory(c.id)}>{catLabel(c)}</button>
            ))}
          </div>
        )}
      </header>

      <div className="sb-layout">
        <div className={`sb-scrim${drawer ? ' is-on' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <aside className={`sb-side${drawer ? ' is-open' : ''}`} aria-label="Filters">
          <header className="sb-side__head">
            <h2>Filters</h2>
            <button type="button" className="sb-x" onClick={() => setDrawer(false)} aria-label="Close filters">✕</button>
          </header>

          <h3 className="sb-sec">Category</h3>
          <ul className="sb-opts">
            <li><button type="button" aria-pressed={!categoryId} onClick={() => pickCategory('')}><span className="sb-opts__e" aria-hidden="true">·</span>All plans</button></li>
            {categories.map((c) => (
              <li key={c.id}>
                <button type="button" aria-pressed={categoryId === c.id} onClick={() => pickCategory(c.id)}>
                  <span className="sb-opts__e" aria-hidden="true">{(c.name || '•').charAt(0).toUpperCase()}</span>{c.name}
                </button>
              </li>
            ))}
          </ul>

          <h3 className="sb-sec">Price</h3>
          <div className="sb-pills" role="radiogroup" aria-label="Price">
            {PRICES.map((p) => (
              <button key={p.value} type="button" role="radio" aria-checked={price === p.value}
                className={price === p.value ? 'is-on' : ''} onClick={() => setPrice(p.value)}>{p.label}</button>
            ))}
          </div>

          <h3 className="sb-sec sb-mobsort">Sort by</h3>
          <div className="sb-pills sb-mobsort" role="radiogroup" aria-label="Sort by">
            {SORTS.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={sort === o.value}
                className={sort === o.value ? 'is-on' : ''} onClick={() => setSort(o.value)}>{o.label}</button>
            ))}
          </div>

          <div className="sb-side__foot">
            <button type="button" className="sb-btn" onClick={reset} disabled={activeFilters === 0 && sort === 'new'}>Reset</button>
            <button type="button" className="sb-btn sb-btn--solid sb-only-m" onClick={() => setDrawer(false)}>
              Show {list.length} {list.length === 1 ? 'plan' : 'plans'}
            </button>
          </div>
        </aside>

        <section className="sb-main">
          <div className="sb-bar">
            <p className="sb-count" role="status">{loading ? 'Looking…' : `${list.length} ${list.length === 1 ? 'plan' : 'plans'}`}</p>
            <label className="sb-sort">
              <span className="sb-sort__lab">Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort plans">
                {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <ErrorAlert error={error} onRetry={() => window.location.reload()} />
          {loading && <ChillLoader kind="plans" />}
          {!loading && list.length === 0 && (
            <div className="empty-state">
              <p>{results?.length ? 'No plans fit those filters. Try widening the price.' : 'Nothing matches yet. Try a different category, or be the first to post one.'}</p>
              {(activeFilters > 0 || sort !== 'new') && <button type="button" className="sb-btn" onClick={reset}>Clear filters</button>}
            </div>
          )}

          <div className="sb-grid">
            {shown.map((service) => {
              const look = looks[service.id];
              const host = service.provider?.username || 'Someone';
              return (
                <button
                  key={service.id}
                  type="button"
                  className="sb-card"
                  aria-haspopup="dialog"
                  onClick={(e) => openService(service.id, e.currentTarget)}
                  data-tint={look.tint.name}
                  style={{ '--avatar-shape': look.avatarShape }}
                >
                  <span className="sb-card__top">
                    {service.category?.name
                      ? <span className="sb-cat">{service.category.name}</span>
                      : <span />}
                    <span className="sb-price">{formatPrice(service.price)}</span>
                  </span>
                  <strong className="sb-card__title">{service.title}</strong>
                  <span className="sb-host">
                    <span className="sb-av" aria-hidden="true">{initial(host)}</span>
                    <span className="sb-host__name">Hosted by {host}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {pages > 1 && (
            <nav className="sb-pager" aria-label="More plans">
              <button type="button" className="sb-pager__btn" disabled={safePage === 0} aria-label="Previous page"
                onClick={() => { setPage(safePage - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>‹</button>
              <span className="sb-pager__txt" role="status">Page {safePage + 1} of {pages}</span>
              <button type="button" className="sb-pager__btn" disabled={safePage >= pages - 1} aria-label="Next page"
                onClick={() => { setPage(safePage + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>›</button>
            </nav>
          )}
        </section>
      </div>

      {active && (
        <div className="sb-pop" onClick={closeService}>
          <div
            className="sb-pop__card"
            role="dialog"
            aria-modal="true"
            aria-label={active.s.title}
            onClick={(e) => e.stopPropagation()}
            data-tint={active.look.tint.name}
            style={{ '--avatar-shape': active.look.avatarShape }}
          >
            <span className="sb-grab" aria-hidden="true" />
            <button ref={closeRef} type="button" className="sb-pop__close" aria-label="Close" onClick={closeService}>×</button>
            <div className="sb-pop__top">
              {active.s.category?.name && <span className="sb-cat">{active.s.category.name}</span>}
              <span className="sb-price sb-price--lg">{formatPrice(active.s.price)}</span>
            </div>
            <h2 className="sb-pop__title">{active.s.title}</h2>
            <div className="sb-host sb-host--lg">
              <span className="sb-av sb-av--lg" aria-hidden="true">{initial(active.s.provider?.username)}</span>
              <span className="sb-host__name">Hosted by <strong>{active.s.provider?.username}</strong></span>
            </div>
            {(active.s.area || active.s.general_location) && <p className="sb-pop__line"><Icon name="pin" size={16} /> {active.s.area || active.s.general_location}</p>}
            {active.s.description && <p className="sb-pop__bio">{active.s.description}</p>}
            <ErrorAlert error={popupError} />
            <div className="sb-pop__actions">
              <Link className="sb-btn sb-btn--solid" to={`/services/${active.s.id}`}>View details</Link>
              {user && active.s.provider?.id && active.s.provider.id !== user.id && (
                <button type="button" className="sb-btn" disabled={messaging} onClick={() => messageHost(active.s)}>
                  {messaging ? <Spinner /> : 'Message host'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
