import { apiFetch } from './client';

export const listBookings = (params) => apiFetch('/api/bookings/', { query: params });

export const getBooking = (id) => apiFetch(`/api/bookings/${id}/`);

export const createBooking = (fields) => apiFetch('/api/bookings/', { method: 'POST', body: fields });

export const transitionBooking = (id, to_status, note) =>
  apiFetch(`/api/bookings/${id}/transition/`, { method: 'POST', body: { to_status, note } });

export const fundBooking = (id) => apiFetch(`/api/bookings/${id}/fund/`, { method: 'POST' });

export const releaseBookingFunds = (id) => apiFetch(`/api/bookings/${id}/release/`, { method: 'POST' });

export const refundCancelBooking = (id) => apiFetch(`/api/bookings/${id}/refund-cancel/`, { method: 'POST' });

export const resolveDispute = (id, resolution, reason) =>
  apiFetch(`/api/bookings/${id}/resolve-dispute/`, { method: 'POST', body: { resolution, reason } });

export const listBookingEvents = (id) => apiFetch(`/api/bookings/${id}/events/`);

export const leaveReview = (id, rating, comment) =>
  apiFetch(`/api/bookings/${id}/review/`, { method: 'POST', body: { rating, comment } });
