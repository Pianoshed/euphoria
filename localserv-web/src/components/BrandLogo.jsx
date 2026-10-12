import { Link } from 'react-router-dom';
import { BRAND_NAME, BRAND_TAGLINE } from '../brand';
import './brand-logo.css';

/**
 * The Hiclr wordmark, as plain text (the logo image and intro video are no longer used in the page body;
 * the favicon/head carries the artwork).
 *
 *   surface   'light' | 'dark' | 'auto'. 'dark' = white text for dark backgrounds, 'light' = dark ink,
 *             'auto' follows the app's data-theme.
 *   tagline   also show "Your vibe. Your people." under the name.
 *   to        wraps it in a link (default "/"); pass null/'' for no link.
 *
 * `animated` is accepted and ignored so existing call sites keep working.
 */
export default function BrandLogo({ surface = 'auto', tagline = false, to = '/', className = '', onClick }) {
  const mark = (
    <span className={`brand-logo brand-logo--${surface} ${className}`}>
      <span className="brand-logo__name">{BRAND_NAME}</span>
      {tagline && <span className="brand-logo__tagline">{BRAND_TAGLINE}</span>}
    </span>
  );
  if (!to) return mark;
  return <Link to={to} className="brand-logo-link" aria-label={`${BRAND_NAME} home`} onClick={onClick}>{mark}</Link>;
}
