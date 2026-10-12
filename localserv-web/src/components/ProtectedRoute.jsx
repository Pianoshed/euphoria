import '../styles/index.css';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SessionLoading } from './ui';

export function ProtectedRoute({ children }) {
  const { user, checkingSession, sessionExpired, accountSuspended, sessionUnreachable } = useAuth();
  const location = useLocation();

  if (checkingSession) {
    return <SessionLoading unreachable={sessionUnreachable} />;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location, expired: sessionExpired, suspended: accountSuspended }} replace />;
  }
  return children;
}
