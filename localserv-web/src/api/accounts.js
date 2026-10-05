import { apiFetch } from './client';

export const register = (email, username, password, role) =>
  apiFetch('/api/accounts/register/', { method: 'POST', body: { email, username, password, role } });

export const verifyEmail = (token) =>
  apiFetch('/api/accounts/verify-email/', { method: 'POST', body: { token } });

export const resendVerification = (email) =>
  apiFetch('/api/accounts/resend-verification/', { method: 'POST', body: { email } });

export const login = (email, password) =>
  apiFetch('/api/accounts/login/', { method: 'POST', body: { email, password } });

export const verifyLoginMfa = (challenge, code) =>
  apiFetch('/api/accounts/login/verify-2fa/', { method: 'POST', body: { challenge, code } });

export const logout = () => apiFetch('/api/accounts/logout/', { method: 'POST' });

export const requestPasswordReset = (email) =>
  apiFetch('/api/accounts/password/reset/', { method: 'POST', body: { email } });

export const confirmPasswordReset = (token, new_password) =>
  apiFetch('/api/accounts/password/reset/confirm/', { method: 'POST', body: { token, new_password } });

// Accounts created with Google have no password yet, so old_password is only sent when there is one.
export const changePassword = (old_password, new_password) =>
  apiFetch('/api/accounts/password/change/', {
    method: 'POST',
    body: old_password ? { old_password, new_password } : { new_password },
  });

export const getMyProfile = () => apiFetch('/api/accounts/profile/me/');

export const updateMyProfile = (fields) =>
  apiFetch('/api/accounts/profile/me/', { method: 'PATCH', body: fields });

export const getMyPrivacy = () => apiFetch('/api/accounts/profile/privacy/');

export const updateMyPrivacy = (fields) =>
  apiFetch('/api/accounts/profile/privacy/', { method: 'PATCH', body: fields });

export const uploadAvatar = (file) => {
  const form = new FormData();
  form.append('avatar', file);
  return apiFetch('/api/accounts/profile/avatar/', { method: 'POST', body: form });
};

export const getPublicProfile = (userId) => apiFetch(`/api/accounts/profile/${userId}/`);

export const sendPresencePing = () =>
  apiFetch('/api/accounts/presence/ping/', { method: 'POST' });

export const discoverProfiles = (params) => apiFetch('/api/accounts/discover/', { query: params });

export const blockUser = (userId) =>
  apiFetch('/api/accounts/blocks/', { method: 'POST', body: { user_id: userId } });

export const unblockUser = (userId) => apiFetch(`/api/accounts/blocks/${userId}/`, { method: 'DELETE' });

export const listBlocks = () => apiFetch('/api/accounts/blocks/');

export const listSessions = () => apiFetch('/api/accounts/sessions/');

export const revokeSession = (sessionId) =>
  apiFetch(`/api/accounts/sessions/${sessionId}/revoke/`, { method: 'POST' });

export const revokeAllOtherSessions = () =>
  apiFetch('/api/accounts/sessions/revoke-all/', { method: 'POST' });

export const setup2fa = () => apiFetch('/api/accounts/2fa/setup/', { method: 'POST' });

export const confirm2fa = (code) =>
  apiFetch('/api/accounts/2fa/confirm/', { method: 'POST', body: { code } });

export const disable2fa = (password) =>
  apiFetch('/api/accounts/2fa/disable/', { method: 'POST', body: { password } });

// Login only. For an unknown email the server returns
// { needs_signup: true, email, name, suggested_username } instead of logging in.
export const googleLogin = (idToken) =>
  apiFetch('/api/accounts/google/', { method: 'POST', body: { id_token: idToken } });

// Second step of Google signup: send the same (fresh) ID token plus the chosen
// username and role. The server takes the email from the verified token.
export const googleRegister = (idToken, username, password, role) =>
  apiFetch('/api/accounts/google/register/', {
    method: 'POST',
    body: { id_token: idToken, username, password, role },
  });

export const completeOnboarding = (role) =>
  apiFetch('/api/accounts/profile/onboarding/complete/', { method: 'POST', body: { role } });
