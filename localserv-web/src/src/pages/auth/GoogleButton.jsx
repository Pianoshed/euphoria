import '../../styles/index.css';
import { useLayoutEffect, useRef, useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';

// Google's button needs a pixel width (200-400). We measure the container once BEFORE
// rendering it, then only re-render for real size changes (>= 16px). Every width change
// re-initialises Google's script, which is what logs "initialize() is called multiple times".
const MAX = 384;
const MIN = 200;
const STEP = 16;

export default function GoogleButton({ onSuccess, onError, busy = false, text = 'signin_with' }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0); // 0 = not measured yet, button not rendered

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const next = Math.max(MIN, Math.min(MAX, Math.floor(el.clientWidth)));
      setWidth((prev) => (prev && Math.abs(prev - next) < STEP ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`google-btn${busy ? ' google-btn--busy' : ''}`}>
      {width > 0 && (
        <GoogleLogin
          onSuccess={onSuccess}
          onError={onError}
          width={String(width)}
          shape="pill"
          theme="outline"
          size="large"
          text={text}
          logo_alignment="center"
        />
      )}
    </div>
  );
}
