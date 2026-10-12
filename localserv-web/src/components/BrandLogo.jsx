import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BRAND_ASSETS, BRAND_NAME, BRAND_TAGLINE } from '../brand';
import './brand-logo.css';

const WORDMARK = 'HiClr'; // how the name is written in the text logo

/**
 * The HiClr logo.
 *
 *   image     show the real logo image on light theme (nav bar, side menu). On the dark theme, or if the image
 *             file is missing, it falls back to the text wordmark, so it never goes blank.
 *   surface   'light' | 'dark' | 'auto'. 'dark' = white text on a dark background, 'auto' follows data-theme.
 *   tagline   also show "Your vibe. Your people." under the name.
 *   to        wraps it in a link (default "/"); pass null/'' for no link.
 */
export default function BrandLogo({ image = false, surface = 'auto', tagline = false, to = '/', className = '', onClick }) {
  const [imgFailed, setImgFailed] = useState(false);
  const withImage = image && !imgFailed;

  const mark = (
    <span className={`brand-logo brand-logo--${surface} ${withImage ? 'brand-logo--has-img' : ''} ${className}`}>
      {withImage && (
        <img className="brand-logo__img" src={BRAND_ASSETS.logoLight} alt={BRAND_NAME} width="876" height="444"
             decoding="async" onError={() => setImgFailed(true)} />
      )}
      <span className="brand-logo__text">
        <span className="brand-logo__name">{WORDMARK}</span>
        {tagline && <span className="brand-logo__tagline">{BRAND_TAGLINE}</span>}
      </span>
    </span>
  );
  if (!to) return mark;
  return <Link to={to} className="brand-logo-link" aria-label={`${BRAND_NAME} home`} onClick={onClick}>{mark}</Link>;
}
