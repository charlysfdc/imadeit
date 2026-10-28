// Reading and writing spreadsheets as CSV, which Google Sheets, Excel and Numbers all open and save.

// Splits CSV text into rows of cells, handling quotes, commas and line breaks inside quotes.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  // Spreadsheets saved in some regions use semicolons instead of commas.
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // The byte-order mark makes Excel read accented letters and symbols correctly.
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// The columns ImadeIt writes, and the other headings it understands when reading someone's own sheet.
export const COLUMNS = [
  { key: 'number', label: 'Blanket #', also: ['blanket', 'blanketno', 'blanketnumber', 'number', 'no', 'num', '#'] },
  { key: 'title', label: 'Name', also: ['name', 'title', 'blanketname'] },
  { key: 'started', label: 'Started', also: ['started', 'start', 'datestarted', 'startdate', 'begun'] },
  { key: 'finished', label: 'Finished', also: ['finished', 'datefinished', 'finishdate', 'completed', 'done', 'enddate'] },
  { key: 'size', label: 'Size', also: ['size', 'sizename'] },
  { key: 'plannedWidth', label: 'Planned width', also: ['plannedwidth'] },
  { key: 'plannedLength', label: 'Planned length', also: ['plannedlength'] },
  { key: 'width', label: 'Finished width', also: ['finishedwidth', 'width', 'actualwidth'] },
  { key: 'length', label: 'Finished length', also: ['finishedlength', 'length', 'actuallength'] },
  { key: 'stitchesWide', label: 'Stitches wide', also: ['stitcheswide', 'stitches', 'loops', 'castonloops', 'caston', 'loopswide'] },
  { key: 'rows', label: 'Rows', also: ['rows', 'totalrows'] },
  { key: 'pattern', label: 'Pattern', also: ['pattern', 'patternname'] },
  { key: 'brand', label: 'Yarn brand', also: ['yarnbrand', 'brand', 'yarn', 'yarnline'] },
  { key: 'color', label: 'Yarn colour', also: ['yarncolour', 'yarncolor', 'colour', 'color'] },
  { key: 'planned', label: 'Skeins planned', also: ['skeinsplanned', 'plannedskeins'] },
  { key: 'used', label: 'Skeins used', also: ['skeinsused', 'usedskeins', 'skeins', 'numberofskeins', 'howmanyskeins'] },
  { key: 'notes', label: 'Notes', also: ['notes', 'note', 'comments', 'comment'] },
];

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9#]/g, '');

// Returns { key: columnIndex } for the headings it recognises, and the headings it didn't.
export function mapHeadings(headings) {
  const map = {};
  const unknown = [];
  headings.forEach((h, i) => {
    const s = squash(h);
    const col = COLUMNS.find((c) => c.also.includes(s));
    if (col && !(col.key in map)) map[col.key] = i;
    else if (s) unknown.push(h.trim());
  });
  return { map, unknown };
}

const pad = (n) => String(n).padStart(2, '0');

// Understands 2026-10-21, 10/21/2026, 10/21/26 and "Oct 21, 2026". Returns YYYY-MM-DD or ''.
export function parseDate(text) {
  const t = (text || '').trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${pad(m[1])}-${pad(m[2])}`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseNumber(text) {
  const t = String(text ?? '').trim().replace(/[^\d.,-]/g, '').replace(',', '.');
  if (!t) return '';
  const n = Number(t);
  return Number.isFinite(n) ? n : '';
}
