import { useState } from 'react';

/**
 * A password <input> with a Show / Hide toggle. Takes the same props as <input>
 * (id, value, onChange, required, minLength, autoComplete, className, ...).
 */
export default function PasswordInput({ style, ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <input {...props} type={shown ? 'text' : 'password'} style={{ paddingRight: '4.5rem', ...style }} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        style={{
          position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 0, padding: '0.25rem 0.5rem', cursor: 'pointer',
          font: 'inherit', fontSize: '0.85rem', fontWeight: 600, color: 'inherit', opacity: 0.75,
        }}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
