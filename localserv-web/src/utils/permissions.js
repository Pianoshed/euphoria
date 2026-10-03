export function isStaff(user) {
  return Boolean(user && (user.is_staff === true || user.role === 'ADMIN' || user.role === 'MODERATOR'));
}
