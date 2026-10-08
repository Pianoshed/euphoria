// Draws a friend tree to a PNG with plain canvas (no libraries, initials only, no remote images).
import { CIRCLES, circleMeta, fruitFor, hasLabels, labelFor } from './circles';

const W = 1080;
const INK = '#1f1d3d';

const fit = (ctx, text, max) => {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
};

function wrap(ctx, text, max) {
  const lines = [];
  let line = '';
  text.split(/\s+/).forEach((w) => {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  });
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function bubble(ctx, x, y, r, name, color, glyph) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
  if (glyph) { ctx.font = `${Math.round(r * 1.05)}px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif`; ctx.fillText(glyph, x, y + 3); return; }
  ctx.fillText((name || '?').charAt(0).toUpperCase(), x, y + 2);
}

export function drawTree(tree) {
  const members = tree.members || [];
  const mine = hasLabels(tree); // same structured picture for the owner and everyone tagged in it
  const partners = mine ? members.filter((m) => labelFor(tree, m) === 'partner') : [];
  // tiers hang down the trunk, closest first (family, besties, friends...); partner is attached to the owner instead
  const tiers = (mine
    ? CIRCLES.filter((c) => c.key !== 'partner').map((c) => ({ label: c.label, color: c.color, people: members.filter((m) => labelFor(tree, m) === c.key) }))
    : [{ label: 'In this tree', color: '#3d3b94', people: members }]
  ).filter((t) => t.people.length);

  const oy = tree.note ? 330 : 270;       // owner + partner row
  const tierR = (ti) => Math.max(26, 38 - ti * 2);
  let y = oy + 120;
  const layout = tiers.map((t, ti) => {
    const r = tierR(ti);
    const cell = r * 2 + 44;
    const perRow = Math.max(1, Math.floor((W - 120) / cell));
    const rows = Math.ceil(t.people.length / perRow);
    const L = { ...t, r, cell, perRow, rows, headY: y, firstY: y + 46 + r };
    y += 46 + rows * (r * 2 + 58) + 26;
    return L;
  });
  const H = Math.max(900, y + 60);

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#fff0b8'); g.addColorStop(0.55, '#ffd7c8'); g.addColorStop(1, '#e4defa');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = '800 52px system-ui, sans-serif';
  ctx.fillText(fit(ctx, tree.title, W - 140), W / 2, 110);
  if (tree.note) {
    ctx.font = '500 26px system-ui, sans-serif'; ctx.fillStyle = '#5f5d7a';
    wrap(ctx, tree.note, W - 200).forEach((l, i) => ctx.fillText(l, W / 2, 160 + i * 34));
  }

  // trunk from the owner through every tier, with a knot where each tier attaches
  if (layout.length) {
    ctx.strokeStyle = INK; ctx.globalAlpha = 0.3; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(W / 2, oy + 60); ctx.lineTo(W / 2, layout[layout.length - 1].headY + 4); ctx.stroke();
    ctx.globalAlpha = 1;
    layout.forEach((L) => { ctx.beginPath(); ctx.arc(W / 2, L.headY - 8, 8, 0, Math.PI * 2); ctx.fillStyle = L.color; ctx.fill(); });
  }

  // owner, with partner bubble(s) attached on either side
  partners.forEach((m, k) => {
    const side = k % 2 === 0 ? 1 : -1;
    const x = W / 2 + side * (82 + Math.floor(k / 2) * 76);
    bubble(ctx, x, oy + 10, 42, m.name, circleMeta('partner').color, m.hidden ? fruitFor(m.id) : null);
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '600 21px system-ui, sans-serif';
    if (!m.hidden) ctx.fillText(fit(ctx, m.name, 150), x, oy + 86);
    const jx = x - side * 46;                                   // little heart where the two bubbles meet
    ctx.beginPath(); ctx.arc(jx, oy - 24, 14, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = '#c2275f'; ctx.font = '700 18px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('♥', jx, oy - 23);
  });
  bubble(ctx, W / 2, oy, 58, tree.owner.name, '#e2394a');
  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText(fit(ctx, tree.owner.name, 300), W / 2, oy + 98);

  layout.forEach((L) => {
    ctx.fillStyle = L.color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '800 24px system-ui, sans-serif';
    ctx.fillText(`${L.label} · ${L.people.length}`, W / 2, L.headY + 24);
    L.people.forEach((m, i) => {
      const row = Math.floor(i / L.perRow);
      const inRow = row === L.rows - 1 ? L.people.length - row * L.perRow : L.perRow;
      const x = (W - inRow * L.cell) / 2 + (i - row * L.perRow) * L.cell + L.cell / 2;
      const yy = L.firstY + row * (L.r * 2 + 58);
      bubble(ctx, x, yy, L.r, m.name, L.color, m.hidden ? fruitFor(m.id) : null);
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '600 20px system-ui, sans-serif';
      if (!m.hidden) ctx.fillText(fit(ctx, m.name, L.cell - 8), x, yy + L.r + 30);
    });
  });

  ctx.fillStyle = '#5f5d7a'; ctx.font = '600 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Euphoria · friend tree', W / 2, H - 38);
  return c;
}

export const treeBlob = (tree) =>
  new Promise((res, rej) => drawTree(tree).toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the image'))), 'image/png'));

export const treeFileName = (tree) =>
  `${(tree.title || 'friend-tree').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend-tree'}.png`;
