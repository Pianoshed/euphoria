// Draws a friend tree to a PNG with plain canvas (no libraries, initials only, no remote images).
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
  ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
  ctx.fillText((name || '?').charAt(0).toUpperCase(), x, y + 2);
}

export function drawTree(tree) {
  const members = tree.members || [];
  const cols = Math.min(Math.max(members.length, 1), 4);
  const rows = Math.ceil(members.length / cols);
  const cell = (W - 160) / cols;
  const top = 560;
  const H = Math.max(1350, top + rows * 250 + 160);

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#fff0b8'); g.addColorStop(0.55, '#ffd7c8'); g.addColorStop(1, '#e4defa');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = '800 68px system-ui, sans-serif';
  ctx.fillText(fit(ctx, tree.title, W - 140), W / 2, 150);
  if (tree.note) {
    ctx.font = '500 34px system-ui, sans-serif'; ctx.fillStyle = '#5f5d7a';
    wrap(ctx, tree.note, W - 200).forEach((l, i) => ctx.fillText(l, W / 2, 210 + i * 44));
  }

  const oy = 400;
  const gridTop = top + 70;
  ctx.strokeStyle = INK; ctx.globalAlpha = 0.35; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(W / 2, oy + 90); ctx.lineTo(W / 2, top);
  ctx.moveTo(80 + cell / 2, top); ctx.lineTo(W - 80 - cell / 2, top);
  ctx.stroke();

  members.forEach((m, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? members.length - row * cols : cols;
    const start = (W - inRow * cell) / 2;
    const x = start + (i - row * cols) * cell + cell / 2;
    const y = gridTop + row * 250;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, y - 70); ctx.stroke();
  });
  ctx.globalAlpha = 1;

  bubble(ctx, W / 2, oy, 90, tree.owner.name, '#e2394a');
  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.font = '700 32px system-ui, sans-serif';
  ctx.fillText(fit(ctx, tree.owner.name, 420), W / 2, oy + 140);

  members.forEach((m, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? members.length - row * cols : cols;
    const start = (W - inRow * cell) / 2;
    const x = start + (i - row * cols) * cell + cell / 2;
    const y = gridTop + row * 250;
    bubble(ctx, x, y, 66, m.name, PAL[i % PAL.length]);
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.fillText(fit(ctx, m.name, cell - 16), x, y + 118);
  });

  ctx.fillStyle = '#5f5d7a'; ctx.font = '600 28px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Euphoria · friend tree', W / 2, H - 60);
  return c;
}

export const treeBlob = (tree) =>
  new Promise((res, rej) => drawTree(tree).toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the image'))), 'image/png'));

export const treeFileName = (tree) =>
  `${(tree.title || 'friend-tree').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend-tree'}.png`;
