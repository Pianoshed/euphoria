import { useCallback, useState } from 'react';

/**
 * Which conversations the person has tucked away, and when.
 *
 * The backend has no "archived" flag on a conversation yet, so this lives in
 * localStorage on this browser: { [conversationId]: archivedAtISO }.
 * To make it follow the person across devices, keep this hook's return shape
 * and swap the read/write below for API calls (e.g. POST
 * /api/chat/conversations/:id/archive/ and .../unarchive/).
 */

const KEY = 'euphoria.archivedChats';

function read() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function write(value) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* private mode or full: archive still works for this visit */
  }
}

export function useArchivedChats() {
  const [archived, setArchived] = useState(read);

  const archive = useCallback((ids) => {
    const now = new Date().toISOString();
    setArchived((prev) => {
      const next = { ...prev };
      for (const id of [].concat(ids)) next[id] = now;
      write(next);
      return next;
    });
  }, []);

  const restore = useCallback((id) => {
    setArchived((prev) => {
      const next = { ...prev };
      delete next[id];
      write(next);
      return next;
    });
  }, []);

  return { archived, archive, restore };
}
