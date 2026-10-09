import '../../styles/index.css';
import './plans.css';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as servicesApi from '../../api/services';
import { ErrorAlert, Spinner } from '../../components/ui';

export default function ListingForm() {
  const { id } = useParams(); // undefined on the "new" route
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState({ category_id: '', title: '', description: '', price: '', service_area: '' });
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    servicesApi.listCategories().then(setCategories).catch((e) => console.error('Could not load categories', e));
  }, []);

  useEffect(() => {
    if (!isEdit) return;
    servicesApi.getService(id)
      .then((s) => setForm({
        category_id: s.category.id, title: s.title, description: s.description,
        price: s.price, service_area: s.service_area,
      }))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isEdit) {
        await servicesApi.updateService(id, form);
        navigate('/services/mine');
      } else {
        await servicesApi.createService(form);
        navigate('/services/mine');
      }
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="page"><Spinner /></div>;

  return (
    <div className="page pl">
      <header className="pl-hero">
        <h1 className="pl-title">{isEdit ? 'Edit your plan' : 'Post a plan'}</h1>
        <p className="pl-sub">{isEdit ? 'Update the details people see before they ask to join.' : 'Saved as a draft first. Publish it when you are ready.'}</p>
      </header>
      <form onSubmit={handleSubmit} className="pl-form pl-card">
        <ErrorAlert error={error} />
        <div className="pl-field">
          <label htmlFor="category">Category</label>
          <select id="category" className="select" required value={form.category_id} onChange={update('category_id')}>
            <option value="" disabled>What kind of plan is this?</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
          </select>
        </div>
        <div className="pl-field">
          <label htmlFor="title">Title</label>
          <input id="title" className="input" required maxLength={100} placeholder="e.g. Sunset skate + smoothies"
            value={form.title} onChange={update('title')} />
        </div>
        <div className="pl-field">
          <label htmlFor="description">What's the plan?</label>
          <textarea id="description" className="textarea" required maxLength={3000}
            placeholder="Say what you'll be doing, roughly when, and anything people should bring or know before joining."
            value={form.description} onChange={update('description')} />
        </div>
        <div className="pl-field">
          <label htmlFor="price">Price (₦)</label>
          <span className="hint">Enter 0 if it's free to join.</span>
          <input id="price" type="number" min="0" step="0.01" inputMode="decimal" className="input" required
            value={form.price} onChange={update('price')} />
        </div>
        <div className="pl-field">
          <label htmlFor="service_area">Where's it happening? (optional)</label>
          <input id="service_area" className="input" maxLength={100} placeholder="e.g. Yaba, Lagos"
            value={form.service_area} onChange={update('service_area')} />
        </div>
        <button className="pl-btn pl-btn--solid" disabled={submitting} type="submit">
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Post as draft'}
        </button>
      </form>
    </div>
  );
}