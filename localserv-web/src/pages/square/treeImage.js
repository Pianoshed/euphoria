// Draws a friend tree to a PNG with plain canvas (no libraries, initials only, no remote images).
import { circleMeta, labelFor } from './circles';

const W = 1080;
const PAL = ['#f2740f', '#3d3b94', '#1f9d6a', '#e2394a', '#b7791f', '#2b7fb8'];
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

function bubble(ctx, x, y, r, name, color) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
  ctx.fillText((name || '?').charAt(0).toUpperCase(), x, y + 2);
}

export function drawTree(tree) {
  const members = tree.members || [];
  const cols = Math.min(Math.max(members.length, 1), 5);
  const rows = Math.ceil(members.length / cols);
  const cell = (W - 120) / cols;
  const ROW = 170;                       // row height (was 250)
  const oy = tree.note ? 330 : 270;      // owner bubble
  const top = oy + 120;                  // rail the branches hang from
  const gridTop = top + 56;
  const H = Math.max(900, gridTop + rows * ROW + 90);

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

  const pos = (i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? members.length - row * cols : cols;
    const start = (W - inRow * cell) / 2;
    return { x: start + (i - row * cols) * cell + cell / 2, y: gridTop + row * ROW };
  };

  // branches: trunk down from the owner, one rail per row, a twig to each person
  ctx.strokeStyle = INK; ctx.globalAlpha = 0.3; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(W / 2, oy + 60);
  ctx.lineTo(W / 2, gridTop + (rows - 1) * ROW - 70);
  for (let r = 0; r < rows; r += 1) {
    const ids = members.map((_, i) => i).filter((i) => Math.floor(i / cols) === r);
    const railY = r === 0 ? top : gridTop + r * ROW - 70;
    const xs = ids.map((i) => pos(i).x);
    ctx.moveTo(Math.min(...xs, W / 2), railY); ctx.lineTo(Math.max(...xs, W / 2), railY);
    ids.forEach((i) => { const p = pos(i); ctx.moveTo(p.x, railY); ctx.lineTo(p.x, p.y - 46); });
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  bubble(ctx, W / 2, oy, 60, tree.owner.name, '#e2394a');
  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText(fit(ctx, tree.owner.name, 420), W / 2, oy + 98);

  members.forEach((m, i) => {
    const { x, y } = pos(i);
    const circle = tree.mine ? circleMeta(labelFor(tree, m)) : null;   // labels are the owner's view, only drawn on their own tree
    bubble(ctx, x, y, 38, m.name, circle ? circle.color : PAL[i % PAL.length]);
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = '600 21px system-ui, sans-serif';
    ctx.fillText(fit(ctx, m.name, cell - 14), x, y + 76);
    if (circle) {
      ctx.fillStyle = circle.color; ctx.font = '700 17px system-ui, sans-serif';
      ctx.fillText(fit(ctx, circle.label, cell - 14), x, y + 99);
    }
  });

  ctx.fillStyle = '#5f5d7a'; ctx.font = '600 22px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Euphoria · friend tree', W / 2, H - 38);
  return c;
}

export const treeBlob = (tree) =>
  new Promise((res, rej) => drawTree(tree).toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the image'))), 'image/png'));

export const treeFileName = (tree) =>
  `${(tree.title || 'friend-tree').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend-tree'}.png`;
