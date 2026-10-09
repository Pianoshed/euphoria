import '../../styles/index.css';
import { Link } from 'react-router-dom';

/**
 * Left-hand "poster" panel shared by Login + Register.
 * variant: 'cafe' (login) | 'couples' (register). Artwork is CSS, see marketing-auth.css.
 * (The landing pages reuse the same two images -- see euphoria-home.css.)
 */
export default function AuthShowcase({ variant = 'cafe', title, text, event, quote }) {
  return (
    <div className={`auth-panel auth-panel--decorative auth-panel--${variant}`}>
      <div className="auth-showcase__top">
        <Link to="/" className="site-nav__logo">Euphoria</Link>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>

      <div className="auth-showcase__chips" aria-hidden="true">
        <div className="auth-chip auth-chip--event">
          <span className="auth-chip__dot" />
          <div>
            <strong>{event.title}</strong>
            <span>{event.meta}</span>
          </div>
        </div>
        <div className="auth-chip auth-chip--quote">
          <div className="auth-chip__avatar">{quote.name[0]}</div>
          <div>
            <strong>{quote.name}</strong>
            <span>&ldquo;{quote.text}&rdquo;</span>
          </div>
        </div>
      </div>
    </div>
  );
}
