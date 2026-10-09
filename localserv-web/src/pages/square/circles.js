// Circles: the labels a friend tree owner gives each person ("how do I know them?").
// Keys are what get sent to / read from the API; label, icon (a name from components/icons.jsx) and colour are UI only.
export const CIRCLES = [
  { key: 'family', label: 'Family', icon: 'users', color: '#C62F45' },
  { key: 'partner', label: 'Partner', icon: 'heart', color: '#C2275F' },
  { key: 'besties', label: 'Besties', icon: 'star', color: '#A86A00' },
  { key: 'friends', label: 'Friends', icon: 'smile', color: '#1F6FA3' },
  { key: 'work', label: 'Workmates', icon: 'briefcase', color: '#4A3FB5' },
  { key: 'school', label: 'Classmates', icon: 'cap', color: '#17805A' },
  { key: 'neighbours', label: 'Neighbours', icon: 'home', color: '#9A5B13' },
  { key: 'acquaintance', label: 'Acquaintances', icon: 'hand', color: '#6B5A87' },
];

// Not pickable: people who only reach you through a tree someone else made.
export const SHARED = { key: 'shared', label: 'Shared trees', icon: 'tree', color: '#2F7D4F' };

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

// True when we know how the owner labelled people in this tree: always for the owner, and for anyone tagged
// as soon as the server sends labels back (member.label or tree.labels). Drives the structured tree
// (partner beside owner, tiers down the trunk) so every viewer sees the same picture the creator sees.
export const hasLabels = (tree) =>
  !!tree.mine || (tree.members || []).some((m) => valid(m.label) || valid(tree.labels?.[m.id]));

// Tagged people see only their own spot by name; everyone else in the tree is hidden and drawn as a fruit or a gift.
const FRUITS = ['🍎', '🍊', '🍇', '🍓', '🍑', '🍋', '🍐', '🥭', '🍒', '🎁'];
export const fruitFor = (id) => {
  let h = 0;
  String(id).split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
  return FRUITS[h % FRUITS.length];
};
