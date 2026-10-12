import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BRAND_ASSETS, BRAND_NAME } from '../brand';
import './brand-logo.css';

const PLAYED_KEY = 'hiclr.introPlayed'; // play the intro once per browser session, not on every visit to "/"

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The Hiclr logo. Always renders a real <img> of the FINAL brand mark, so the logo can never go blank.
 *
 *   animated  (homepage hero only) lays the 3-second intro video on top of that image. The video fades in
 *             when it really starts playing and fades out when it ends, revealing the identical final frame.
 *             No autoplay, reduced motion, data-saver, an error or a repeat visit in the same session: the
 *             image simply stays and the video is never shown.
 *   surface   'light' | 'dark' | 'auto'. 'dark' uses the final video frame (made for dark backgrounds);
 *             'light' uses the flat logo with dark ink; 'auto' picks by the app's data-theme.
 *   to        wraps the logo in a link (default "/", same as the old text brand).
 */
export default function BrandLogo({ animated = false, surface = 'auto', to = '/', className = '', onClick }) {
  const videoRef = useRef(null);
  const [phase, setPhase] = useState('static'); // 'static' | 'playing'

  useEffect(() => {
    if (!animated || surface === 'light') return undefined; // the video is made for dark surfaces
    const video = videoRef.current;
    if (!video) return undefined;
    let alreadyPlayed = false;
    try { alreadyPlayed = sessionStorage.getItem(PLAYED_KEY) === '1'; } catch { /* storage blocked */ }
    const saveData = navigator.connection?.saveData === true;
    if (alreadyPlayed || reducedMotion() || saveData) return undefined; // keep the static logo, never fetch the video

    const onPlaying = () => setPhase('playing');
    const done = () => {
      setPhase('static');
      try { sessionStorage.setItem(PLAYED_KEY, '1'); } catch { /* ignore */ }
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('ended', done);
    video.addEventListener('error', done);
    video.load();
    const attempt = video.play();
    if (attempt?.catch) attempt.catch(done); // autoplay refused: stay on the static logo
    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('ended', done);
      video.removeEventListener('error', done);
    };
  }, [animated, surface]);

  const mark = (
    <span className={`brand-logo brand-logo--${surface} ${animated ? 'brand-logo--animated' : ''} ${className}`}>
      {/* Explicit surfaces render only the artwork they need; 'auto' renders both (CSS picks by theme) and
          lazy-loads them so the hidden one is never downloaded. */}
      {surface !== 'dark' && (
        <img className="brand-logo__img brand-logo__img--light" src={BRAND_ASSETS.logoLight} alt={BRAND_NAME} width="876" height="444" decoding="async" loading={surface === 'auto' ? 'lazy' : undefined} />
      )}
      {surface !== 'light' && (
        <img className="brand-logo__img brand-logo__img--dark" src={BRAND_ASSETS.logoDark} alt={BRAND_NAME} width="876" height="444" decoding="async" loading={surface === 'auto' ? 'lazy' : undefined} />
      )}
      {animated && (
        <video
          ref={videoRef}
          className={`brand-logo__video ${phase === 'playing' ? 'is-playing' : ''}`}
          muted playsInline preload="none" aria-hidden="true" tabIndex={-1} disablePictureInPicture
          width="876" height="444"
        >
          <source src={BRAND_ASSETS.introWebm} type="video/webm" />
          <source src={BRAND_ASSETS.introMp4} type="video/mp4" />
        </video>
      )}
    </span>
  );

  if (!to) return mark;
  return <Link to={to} className="brand-logo-link" aria-label={`${BRAND_NAME} home`} onClick={onClick}>{mark}</Link>;
}
