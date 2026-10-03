// Naira formatting shared by listings, bookings and the wallet.
// The API sends decimal strings ("3500.00"); people want "₦3,500".

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function formatNaira(value) {
  const n = toNumber(value);
  if (n === null) return `₦${value ?? 0}`;
  const abs = Math.abs(n);
  const body = abs.toLocaleString('en-NG', {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? '\u2212' : ''}₦${body}`;
}

// For things hosts charge for: 0 reads as "Free" (same wording the home page uses).
export function formatPrice(value) {
  return toNumber(value) === 0 ? 'Free' : formatNaira(value);
}
