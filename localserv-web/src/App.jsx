import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { GuestRoute } from './components/GuestRoute';
import { NavBar } from './components/NavBar';
import MessageNotifier from './components/MessageNotifier';

import Register from './pages/auth/Register';
import VerifyEmail from './pages/auth/VerifyEmail';
import Login from './pages/auth/Login';
import LoginTwoFactor from './pages/auth/LoginTwoFactor';
import PasswordResetRequest from './pages/auth/PasswordResetRequest';
import PasswordResetConfirm from './pages/auth/PasswordResetConfirm';

import ServiceBrowse from './pages/services/ServiceBrowse';
import ServiceDetail from './pages/services/ServiceDetail';
import MyListings from './pages/services/MyListings';
import ListingForm from './pages/services/ListingForm';

import MyBookings from './pages/bookings/MyBookings';
import BookingDetail from './pages/bookings/BookingDetail';

import WalletPage from './pages/wallet/Wallet';

import ConversationList from './pages/chat/ConversationList';
import ConversationView from './pages/chat/ConversationView';
import CallLog from './pages/chat/CallLog';

import MyProfile from './pages/profile/MyProfile';
import PublicProfile from './pages/profile/PublicProfile';
import Discover from './pages/profile/Discover';
import Sessions from './pages/profile/Sessions';
import TwoFactorSettings from './pages/profile/TwoFactorSettings';
import ModerationDashboard from './pages/profile/ModerationDashboard';

import Home from './pages/Home';
import NotFound from './pages/NotFound';

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />

      <Route path="/register" element={<GuestRoute><Register /></GuestRoute>} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/login" element={<GuestRoute><Login /></GuestRoute>} />
      <Route path="/login/2fa" element={<GuestRoute><LoginTwoFactor /></GuestRoute>} />
      <Route path="/password-reset" element={<PasswordResetRequest />} />
      <Route path="/password-reset/confirm" element={<PasswordResetConfirm />} />

      <Route path="/services" element={<ServiceBrowse />} />
      <Route path="/services/mine" element={<ProtectedRoute><MyListings /></ProtectedRoute>} />
      <Route path="/services/mine/new" element={<ProtectedRoute><ListingForm /></ProtectedRoute>} />
      <Route path="/services/mine/:id/edit" element={<ProtectedRoute><ListingForm /></ProtectedRoute>} />
      <Route path="/services/:id" element={<ServiceDetail />} />

      <Route path="/bookings" element={<ProtectedRoute><MyBookings /></ProtectedRoute>} />
      <Route path="/bookings/:id" element={<ProtectedRoute><BookingDetail /></ProtectedRoute>} />

      <Route path="/wallet" element={<ProtectedRoute><WalletPage /></ProtectedRoute>} />

      <Route path="/chat" element={<ProtectedRoute><ConversationList /></ProtectedRoute>} />
      <Route path="/chat/:id" element={<ProtectedRoute><ConversationView /></ProtectedRoute>} />
      <Route path="/calls" element={<ProtectedRoute><CallLog /></ProtectedRoute>} />

      <Route path="/providers" element={<ProtectedRoute><Discover /></ProtectedRoute>} />
      <Route path="/profile/me" element={<ProtectedRoute><MyProfile /></ProtectedRoute>} />
      <Route path="/profile/sessions" element={<ProtectedRoute><Sessions /></ProtectedRoute>} />
      <Route path="/profile/2fa" element={<ProtectedRoute><TwoFactorSettings /></ProtectedRoute>} />
      <Route path="/profile/:id" element={<ProtectedRoute><PublicProfile /></ProtectedRoute>} />

      <Route path="/moderation" element={<ProtectedRoute><ModerationDashboard /></ProtectedRoute>} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <Router>
        <AuthProvider>
          <NavBar />
          <MessageNotifier />
          <AppRoutes />
        </AuthProvider>
      </Router>
    </GoogleOAuthProvider>
  );
}