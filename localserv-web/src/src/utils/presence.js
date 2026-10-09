export function presenceLabel(profile) {
  if (!profile || !('online' in profile)) return null; // viewer can't see presence for this user

  if (profile.online) return { online: true, text: 'Online now' };

  if (!('last_seen_at' in profile) || !profile.last_seen_at) return null;

  const diffMs = Date.now() - new Date(profile.last_seen_at).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return { online: false, text: 'Active just now' };
  if (mins < 60) return { online: false, text: `Active ${mins}m ago` };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { online: false, text: `Active ${hours}h ago` };
  return { online: false, text: null };
}