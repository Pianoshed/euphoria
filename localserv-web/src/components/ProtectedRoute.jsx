import '../styles/index.css';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Spinner } from './ui';

export function ProtectedRoute({ children }) {
  const { user, checkingSession } = useAuth();
  const location = useLocation();

  if (checkingSession) {
    return <div className="page page-loading"><Spinner /></div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}
