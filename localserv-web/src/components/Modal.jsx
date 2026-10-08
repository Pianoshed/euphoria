import './modal.css';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small accessible dialog: Escape and backdrop close it, page scroll is locked while it is open,
 * focus moves into it and returns to whatever opened it. Bottom sheet on phones, centred card on desktop.
 */
export default function Modal({ title, subtitle, onClose, children, wide = false }) {
  const [leaving, setLeaving] = useState(false);
  const panel = useRef(null);
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const timer = useRef(null);

  const close = useCallback(() => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = setTimeout(() => closeRef.current?.(), 160);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    panel.current?.focus({ preventScroll: true });
    const from = opener.current;
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = prev;
      clearTimeout(timer.current);
      if (from && typeof from.focus === 'function') from.focus({ preventScroll: true });
    };
  }, [close]);

  return (
    <div className={`modal${leaving ? ' is-leaving' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal__panel${wide ? ' modal__panel--wide' : ''}`}>
        <header className="modal__head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="modal__x" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="modal__body">{typeof children === 'function' ? children(close) : children}</div>
      </div>
    </div>
  );
}
