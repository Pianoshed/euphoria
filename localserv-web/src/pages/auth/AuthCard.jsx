import '../../styles/index.css';
import BrandLogo from '../../components/BrandLogo';

/**
 * Single themed card on the illustrated backdrop.
 * Used by the pages that don't need the poster panel (2FA, reset, verify,
 * "check your email", onboarding).
 */
export default function AuthCard({ children }) {
  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-form-wrap">
          <BrandLogo tagline className="auth-brand-logo" />
          {children}
        </div>
      </div>
    </div>
  );
}
