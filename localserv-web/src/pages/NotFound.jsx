import '../styles/index.css';
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="page page--narrow">
      <span className="pill pill--accent">404</span>
      <h1 style={{ marginTop: 'var(--space-3)' }}>That page wandered off</h1>
      <p className="muted">The link may be old, or the plan may have been taken down.</p>
      <div className="row row--wrap">
        <Link to="/" className="btn btn--primary">Back to home</Link>
        <Link to="/services" className="btn btn--ghost">See what's popping</Link>
      </div>
    </div>
  );
}
