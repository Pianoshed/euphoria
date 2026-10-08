// Circles: the labels a friend tree owner gives each person ("how do I know them?").
// Keys are what get sent to / read from the API; label, emoji and colour are UI only.
export const CIRCLES = [
  { key: 'family', label: 'Family', emoji: '👨‍👩‍👧', color: '#C62F45' },
  { key: 'partner', label: 'Partner', emoji: '💞', color: '#C2275F' },
  { key: 'besties', label: 'Besties', emoji: '💛', color: '#A86A00' },
  { key: 'friends', label: 'Friends', emoji: '🤝', color: '#1F6FA3' },
  { key: 'work', label: 'Workmates', emoji: '💼', color: '#4A3FB5' },
  { key: 'school', label: 'Classmates', emoji: '🎓', color: '#17805A' },
  { key: 'neighbours', label: 'Neighbours', emoji: '🏡', color: '#9A5B13' },
  { key: 'acquaintance', label: 'Acquaintances', emoji: '👋', color: '#6B5A87' },
];

// Not pickable: people who only reach you through a tree someone else made.
export const SHARED = { key: 'shared', label: 'Shared trees', emoji: '🌳', color: '#2F7D4F' };

export const DEFAULT_CIRCLE = 'friends';
const BY_KEY = Object.fromEntries([...CIRCLES, SHARED].map((c) => [c.key, c]));
export const circleMeta = (key) => BY_KEY[key] || BY_KEY[DEFAULT_CIRCLE];

/* The API may not store labels yet. We send them anyway, read them back if the server
   returns them (member.label or tree.labels), and keep a local copy so they survive reloads. */
const LS = 'sq-circles-v1';
let cache = null;
const read = () => {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { cache = {}; }
  return cache;
};
export const saveLocalLabels = (treeId, map) => {
  const all = read();
  all[treeId] = { ...(all[treeId] || {}), ...map };
  try { localStorage.setItem(LS, JSON.stringify(all)); } catch { /* private mode: in-memory only */ }
};
const valid = (k) => (k && BY_KEY[k] && k !== 'shared' ? k : null);
export const labelFor = (tree, member) =>
  valid(member.label) || valid(tree.labels?.[member.id]) || valid(read()[tree.id]?.[member.id]) || DEFAULT_CIRCLE;
