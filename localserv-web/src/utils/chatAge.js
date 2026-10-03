const DAY = 86400000;

export const STALE_AFTER_DAYS = 14;   // nothing said for two weeks
export const LONG_AFTER_DAYS = 60;    // the chat itself is two months old
export const LONG_AFTER_MESSAGES = 200; // used only if the API sends message_count

const toTime = (v) => (v ? new Date(v).getTime() : NaN);

/** "12 Mar", or "12 Mar 2025" when it isn't this year. Empty string if unknown. */
export function startedLabel(iso) {
  const t = toTime(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function span(days) {
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

/**
 * Is this conversation worth suggesting for the archive?
 * Returns null, or { kind: 'stale' | 'long', label }.
 * Anything with unread messages is never suggested.
 */
export function archiveHint(conversation, now = Date.now()) {
  if (conversation.unread_count > 0) return null;

  const lastAt = toTime(conversation.last_message?.created_at ?? conversation.updated_at);
  if (!Number.isNaN(lastAt)) {
    const quietDays = Math.floor((now - lastAt) / DAY);
    if (quietDays >= STALE_AFTER_DAYS) return { kind: 'stale', label: `Quiet for ${span(quietDays)}` };
  }

  const startedAt = toTime(conversation.created_at);
  const ageDays = Number.isNaN(startedAt) ? 0 : Math.floor((now - startedAt) / DAY);
  if (conversation.message_count >= LONG_AFTER_MESSAGES || ageDays >= LONG_AFTER_DAYS) {
    return { kind: 'long', label: 'Long-running chat' };
  }
  return null;
}

/**
 * An archived chat comes back on its own if something new arrives after it
 * was archived, so nobody misses a message from a conversation they shelved.
 */
export function isShelved(conversation, archivedAtIso) {
  if (!archivedAtIso) return false;
  if (conversation.unread_count > 0) return false;
  const lastAt = toTime(conversation.last_message?.created_at);
  return !(lastAt > toTime(archivedAtIso));
}
