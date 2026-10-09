// Shared "bubble" look (shape + tint) so a person is the same colour in Find people and on their profile.
// border-radius values that turn a box into an oblong / pebble / egg.
export const SHAPES = [
  '58% 42% 63% 37% / 45% 55% 45% 55%',
  '40% 60% 55% 45% / 60% 40% 60% 40%',
  '999px',
  '30% 70% 45% 55% / 50% 30% 70% 50%',
  '70% 30% 50% 50% / 30% 60% 40% 70%',
  '50% 50% 50% 50% / 62% 62% 38% 38%',
  '46% 54% 38% 62% / 56% 44% 56% 44%',
];

export const TINTS = [
  { name: 'gold', bg: 'linear-gradient(145deg, #fff0b8, #f6c945)', ring: '#c99a12' },
  { name: 'coral', bg: 'linear-gradient(145deg, #ffe3dd, #ffb9ab)', ring: '#e2394a' },
  { name: 'lilac', bg: 'linear-gradient(145deg, #ece7ff, #cbbff7)', ring: '#6a58d6' },
  { name: 'mint', bg: 'linear-gradient(145deg, #dcf7ea, #a5e3c6)', ring: '#1f9d6a' },
  { name: 'sky', bg: 'linear-gradient(145deg, #dff0ff, #a9d3f7)', ring: '#2f7fc4' },
];

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lookFor(id, shuffle) {
  const rand = seededRandom(hashString(`${id}:${shuffle}`));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const shapeIndex = Math.floor(rand() * SHAPES.length);
  return {
    shape: SHAPES[shapeIndex],
    avatarShape: SHAPES[(shapeIndex + 3) % SHAPES.length],
    tint: pick(TINTS),
    rotate: (rand() * 4 - 2).toFixed(1), // a gentle tilt, nothing wild
  };
}
