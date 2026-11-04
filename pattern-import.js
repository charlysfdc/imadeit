// Reads a pattern PDF on the phone and works out what it can: name, sizes, yarn and the
// instruction for every row. Nothing is uploaded. Written around Rustic Nastalje's Breadcrumb
// layout; other designers' PDFs get whatever matches, and the maker checks it before saving.

// pdfjs is the loaded pdf.js module; data is the file's bytes.
export async function extractPdf(pdfjs, data) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  let title = '';
  try {
    title = (await doc.getMetadata()).info?.Title || '';
  } catch { /* no metadata */ }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const width = page.getViewport({ scale: 1 }).width;
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        x: it.transform[4],
        y: it.transform[5],
        w: it.width,
        h: Math.abs(it.transform[3]) || it.height || 10,
        s: despace(it.str),
      }));
    pages.push({ width, items });
    page.cleanup();
  }
  await task.destroy();
  return { title, pages };
}

// Design tools often store letter-spaced headings as "G r e e n". Put the word back together.
function despace(s) {
  const t = s.trim();
  return /^(\S )+\S$/.test(t) ? t.replace(/ /g, '') : s;
}

const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s+([,.;:)\]])/g, '$1').replace(/([([])\s+/g, '$1').trim();

// Items on the same baseline become one line, read left to right.
function toLines(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < Math.max(r.h, it.h) * 0.5);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const it of r.items) {
      if (end !== null && it.x - end > it.h * 0.15) text += ' ';
      text += it.s;
      end = it.x + it.w;
    }
    return { y: r.y, h: r.h, x: r.items[0].x, text: tidy(text) };
  });
}

const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

function patternName(title, fallback) {
  const t = (title || '').replace(/^\s*pattern\s*:\s*/i, '').replace(/\s*\((?:breadcrumb|pattern)\)\s*$/i, '').trim();
  return titleCase(t) || fallback;
}

// ---- Rows ----

const ROW_HEAD = /^Row\s+(\d+)\s*:\s*/i;

// Each "Row N:" heading owns the text under it in its own column, until the next heading in
// that column or a clear gap. That copes with patterns that lay rows out in two or three columns.
function findRows(pages) {
  const steps = {};
  const weight = {};
  const loopCounts = [];
  for (const page of pages) {
    const heads = page.items.filter((it) => ROW_HEAD.test(it.s));
    if (!heads.length) continue;
    const starts = [];
    for (const x of heads.map((h) => h.x).sort((a, b) => a - b)) {
      if (!starts.length || x - starts[starts.length - 1] > 40) starts.push(x);
    }
    const colOf = (x) => starts.reduce((c, start, i) => (x >= start - 15 ? i : c), 0);
    for (const h of heads) {
      const col = colOf(h.x);
      const left = starts[col] - 15;
      const right = col + 1 < starts.length ? starts[col + 1] - 5 : page.width;
      const nextY = Math.max(-Infinity, ...heads.filter((o) => o !== h && colOf(o.x) === col && o.y < h.y - 1).map((o) => o.y));
      const region = page.items.filter((it) => it.x >= left && it.x < right && it.x + it.w <= right + 12
        && it.y <= h.y + h.h * 0.4 && it.y > nextY + 1
        && !(Math.abs(it.y - h.y) < h.h * 0.5 && it.x < h.x));
      // Stop at the first big vertical gap, so tips and footers below the last row stay out.
      const lines = toLines(region);
      const kept = [];
      for (const line of lines) {
        if (kept.length && kept[kept.length - 1].y - line.y > Math.max(line.h, 9) * 2.8) break;
        kept.push(line);
      }
      let text = '';
      for (const line of kept) {
        const piece = line.text;
        if (!text) text = piece;
        else text += /[,(]$/.test(text) || /^[a-z[(]/.test(piece) ? ` ${piece}` : `, ${piece}`;
      }
      const n = Number(ROW_HEAD.exec(text)?.[1] ?? ROW_HEAD.exec(h.s)[1]);
      text = text.replace(ROW_HEAD, '');
      const loops = text.match(/\[(\d+)\]/);
      if (loops) loopCounts.push(Number(loops[1]));
      text = tidy(text.replace(/\s*\[\d+\]/g, '').replace(/^[,:.\s]+|[,\s]+$/g, '').replace(/,\s*,/g, ','));
      // A tips page may explain "Row 1:" too; the real one sits on a page full of rows.
      if (n && (!steps[n] || heads.length > weight[n])) {
        steps[n] = text;
        weight[n] = heads.length;
      }
    }
  }
  const common = loopCounts.length
    ? [...loopCounts.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0]
    : null;
  return { steps, loops: common };
}

// ---- Sizes ----

const DIM = String.raw`(\d+(?:\.\d+)?)\s*(?:″|"|”|''|in\b|inches)?\s*[x×X]\s*(\d+(?:\.\d+)?)\s*(?:″|"|”|''|in\b|inches)?`;

function findSizes(text, loops, rowCount) {
  const sizes = [];
  // "Petite 25″ x 25″: 17 loops, 18 rows"
  const multi = new RegExp(String.raw`([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,2})\s+${DIM}\s*:?\s*(\d+)\s*loops?\s*[,/]?\s*(\d+)\s*rows?`, 'g');
  for (const m of text.matchAll(multi)) {
    sizes.push({ name: m[1], width: Number(m[2]), length: Number(m[3]), loops: Number(m[4]), rows: Number(m[5]) });
  }
  if (sizes.length) return sizes;
  // "Classic Throw, approx: 50″ x 60″"
  const one = new RegExp(String.raw`([A-Z][a-z]+(?: [A-Za-z][a-z]+){0,2}),?\s*(?:approx(?:imately)?\.?:?|about|measures)\s*${DIM}`);
  const m = text.match(one);
  if (m) sizes.push({ name: titleCase(m[1]), width: Number(m[2]), length: Number(m[3]), loops: loops || '', rows: rowCount || '' });
  return sizes;
}

// ---- Yarn ----

const NOT_COLOURS = new Set(['row', 'rows', 'cast', 'switch', 'next', 'make', 'pull', 'knit', 'purl', 'repeat', 'close', 'chain',
  'keep', 'cut', 'join', 'turn', 'work', 'border', 'round', 'band', 'total', 'skein', 'skeins', 'balls', 'ball', 'about', 'each',
  'yarn', 'chunky', 'jumbo', 'chenille', 'scissors', 'lighter', 'pliers', 'pattern', 'blanket', 'throw', 'size', 'loops', 'and',
  'petite', 'lap', 'nook', 'classic', 'queen', 'king', 'twin', 'baby', 'k', 'p', 'tl', 'bl', 'cl', 'cr', 'inc', 'dec', 'st', 'ch', 'r']);
const isColourName = (s) => !NOT_COLOURS.has(s.toLowerCase()) && !s.split(' ').some((w) => NOT_COLOURS.has(w.toLowerCase()) && w.length < 4 && s.split(' ').length === 1);

function suppliesText(pages) {
  for (const page of pages) {
    const text = toLines(page.items).map((l) => l.text).join('\n');
    if (/supplies|materials|you('|’)ll need|you will need/i.test(text)) {
      const start = text.search(/supplies|materials|you('|’)ll need|you will need/i);
      const end = text.slice(start).search(/general tips|abbreviations|gauge/i);
      return text.slice(start, end > 0 ? start + end : undefined);
    }
  }
  return '';
}

function findYarn(supplies, steps, loops) {
  const yarns = new Map();
  const add = (color, skeins = '', brand = '') => {
    const name = titleCase(color.trim().replace(/^(?:and|of)\s+/i, '').replace(/[.:]$/, ''));
    if (!name || !isColourName(name) || name.length > 30) return;
    const key = name.toLowerCase();
    const prev = yarns.get(key);
    yarns.set(key, { color: name, skeins: skeins !== '' ? skeins : prev?.skeins ?? '', brand: brand || prev?.brand || '' });
  };
  const flat = supplies.replace(/\n/g, ' ');

  // "11 skeins in total: Green 6, Red 2, White 1"
  const list = flat.match(/(?:total|colou?rs?)\s*:\s*((?:[A-Z][A-Za-z]+(?: [A-Za-z]+)?\s+\d+(?:\.\d+)?\s*,?\s*)+)/);
  if (list) for (const m of list[1].matchAll(/([A-Z][A-Za-z]+(?: [A-Za-z]+)?)\s+(\d+(?:\.\d+)?)/g)) add(m[1], Number(m[2]));
  // "5 balls Black, 4 balls Red"
  for (const m of flat.matchAll(/(\d+(?:\.\d+)?)\s*(?:balls?|skeins?)\s+(?:of\s+)?([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)/g)) add(m[2], Number(m[1]));
  // "White, Khaki and Dark Coffee each need about 3 skeins"
  for (const m of flat.matchAll(/((?:[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?(?:,\s*|\s+and\s+))+[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)\s+each\s+need\s+(?:about\s+)?(\d+(?:\.\d+)?)/g)) {
    for (const c of m[1].split(/,\s*|\s+and\s+/)) add(c, Number(m[2]));
  }
  // "in 2 colors: Navy and Light Blue"
  const named = flat.match(/in\s+\d+\s+colou?rs?\s*:\s*([^.]+?)(?=\s+(?:Scissors|Lighter|Pliers)|$)/i);
  if (named) for (const c of named[1].split(/,\s*|\s+and\s+/)) add(c);
  // "2 packs of Cozyful Chunky Yarn #10, Cream & Multi Coffee": the brand for every colour.
  const pack = flat.match(/(\d+)\s*packs?\s+of\s+([^,]+)/i);
  const brand = pack ? pack[2].trim() : '';

  // Colours named in the rows: "Navy K6", "Green 7", "Light Coffee: Broken Herringbone".
  const usage = new Map();
  const rowText = Object.values(steps);
  for (const text of rowText) {
    let counted = false;
    for (const m of text.matchAll(/(?:^|[,:]\s*)([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s*:?\s*[KP]?(\d+)\b/g)) {
      if (!isColourName(m[1])) continue;
      usage.set(m[1], (usage.get(m[1]) || 0) + Number(m[2]));
      counted = true;
    }
    const lead = text.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)?):/);
    if (!counted && lead && isColourName(lead[1]) && loops) usage.set(lead[1], (usage.get(lead[1]) || 0) + loops);
  }
  const seenInRows = [...usage.keys()].filter((c) => rowText.filter((t) => t.includes(c)).length >= 2);
  for (const c of seenInRows) if (!yarns.has(c.toLowerCase())) add(c);
  for (const y of yarns.values()) if (brand && !y.brand) y.brand = brand;

  const totalMatch = flat.match(/(\d+(?:\.\d+)?)\s*skeins?\s+in\s+total/i);
  const perPack = flat.match(/each\s+pack\s+has\s+(\d+)\s+skeins?/i);
  const total = totalMatch ? Number(totalMatch[1]) : pack && perPack ? Number(pack[1]) * Number(perPack[1]) : null;
  const shares = {};
  for (const [c, n] of usage) shares[c.toLowerCase()] = n;
  return { yarns: [...yarns.values()], total, shares };
}

// The whole job: pdf.js output in, a pattern draft out.
export function parsePattern({ title, pages }, fallbackName) {
  const hasText = pages.some((p) => p.items.length > 3);
  const name = patternName(title, fallbackName);
  if (!hasText) return { name, hasText, sizes: [], yarns: [], rowSteps: {}, rows: 0, notes: [] };

  const { steps, loops } = findRows(pages);
  const rowNumbers = Object.keys(steps).map(Number);
  const rowCount = rowNumbers.length ? Math.max(...rowNumbers) : 0;
  const allText = pages.map((p) => toLines(p.items).map((l) => l.text).join('\n')).join('\n');
  const loopsFromCastOn = Number(allText.match(/chain\s+of\s+(\d+)\s+loops|cast\s+on\s+(\d+)\s+loops/i)?.slice(1).find(Boolean)) || loops;
  const sizes = allText.split('\n').reduce((found, line) => (found.length ? found : findSizes(line, loopsFromCastOn, rowCount)), []);
  const supplies = suppliesText(pages);
  const yarn = findYarn(supplies, steps, loopsFromCastOn);

  const notes = [];
  if (yarn.yarns.some((y) => y.skeins === '')) notes.push('Some colours have no skein count in the PDF.');
  if (rowCount && rowNumbers.length < rowCount) notes.push(`Rows ${rowNumbers.length} of ${rowCount} were found.`);
  return { name, hasText, sizes, yarns: yarn.yarns, total: yarn.total, shares: yarn.shares, rowSteps: steps, rows: rowCount, loops: loopsFromCastOn, notes };
}

// Fills in missing skein counts from how much of each colour the rows use, when a total is known.
export function estimateSkeins(draft, totalFromGuide) {
  const missing = draft.yarns.filter((y) => y.skeins === '');
  if (!missing.length) return draft;
  const known = draft.yarns.reduce((n, y) => n + (y.skeins === '' ? 0 : y.skeins), 0);
  const total = draft.total && !draft.yarns.some((y) => y.skeins !== '') ? draft.total : totalFromGuide;
  const weight = (y) => draft.shares?.[y.color.toLowerCase()] || 0;
  const half = (n) => Math.max(0.5, Math.round(n * 2) / 2);
  // With some colours counted, the rest use the same skeins per stitch.
  const counted = draft.yarns.filter((y) => y.skeins !== '' && weight(y));
  const countedStitches = counted.reduce((n, y) => n + weight(y), 0);
  if (countedStitches) {
    const perStitch = counted.reduce((n, y) => n + y.skeins, 0) / countedStitches;
    for (const y of missing) if (weight(y)) Object.assign(y, { skeins: half(weight(y) * perStitch), estimated: true });
    return draft;
  }
  // Otherwise share the total (from the PDF, or the skein guide for this size) by stitches.
  const sum = missing.reduce((n, y) => n + weight(y), 0);
  if (!total || !sum) return draft;
  for (const y of missing) Object.assign(y, { skeins: half(((total - known) * weight(y)) / sum), estimated: true });
  return draft;
}
