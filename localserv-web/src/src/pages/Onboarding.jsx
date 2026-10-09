import '../styles/index.css';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import * as accountsApi from '../api/accounts';
import { useAuth } from '../context/AuthContext';
import { ErrorAlert } from '../components/ui';
import AuthCard from './auth/AuthCard';
import RoleChoice from './auth/RoleChoice';

export default function Onboarding() {
  const { user, refreshSession } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState('CUSTOMER');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (user && user.role_confirmed) {
    return <Navigate to="/services" replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await accountsApi.completeOnboarding(role);
      await refreshSession();
      navigate('/services', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard>
      <h1>One last thing</h1>
      <p className="auth-sub">Tell us what brings you here.</p>

      <form onSubmit={handleSubmit} className="stack">
        <ErrorAlert error={error} />
        <RoleChoice value={role} onChange={setRole} />
        <button className="btn btn--primary btn--block" disabled={submitting} type="submit">
          {submitting ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </AuthCard>
  );
}
