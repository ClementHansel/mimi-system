import fs from 'node:fs';

const SRC = 'docs/PROGRESS.md';
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

// ---- locate top-level sections -------------------------------------------
const secs = [];
lines.forEach((l, i) => {
  const m = l.match(/^## (.+)/);
  if (m) secs.push({ title: m[1], start: i });
});
secs.forEach((s, i) => {
  s.end = i + 1 < secs.length ? secs[i + 1].start : lines.length;
});
const sec = (pred) => secs.find((s) => pred(s.title));
const range = (s) => lines.slice(s.start, s.end).map((t, i) => [s.start + i + 1, t]);

const rows = [];
const clean = (s) => s.replace(/\s+/g, ' ').trim();
// strip bold/strike/leading dashes but KEEP inline code and link text
const plain = (s) =>
  clean(
    s
      .replace(/\*\*/g, '')
      .replace(/~~/g, '')
      .replace(/^[-\u2013\u2014\s]+/, ''),
  );
const shorten = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026');

const STATE = { x: 'Done', '~': 'In Progress', ' ': 'Todo', '!': 'Todo' };

// ---- 1. wave task register (section 4) -----------------------------------
const reg = sec((t) => /^4\./.test(t));
let wave = null;
const regLines = range(reg);
for (let i = 0; i < regLines.length; i++) {
  const [ln, text] = regLines[i];
  const wm = text.match(/^### (Wave [^\u2014]+)/);
  if (wm) {
    wave = clean(wm[1])
      .replace(/[\u2705\u{1F504}\u2B1C]/gu, '')
      .trim();
    continue;
  }
  const m = text.match(/^- \[([x~ !])\] (.*)$/);
  if (!m) continue;

  const body = m[2];
  const cont = [];
  let j = i + 1;
  while (
    j < regLines.length &&
    !/^- \[/.test(regLines[j][1]) &&
    /^(\s{2,}\S|\s*$)/.test(regLines[j][1])
  ) {
    if (regLines[j][1].trim()) cont.push(regLines[j][1].trim());
    j++;
    if (cont.length > 40) break;
  }

  // id = leading bold token, or first token inside a bold span
  let id = null;
  let title = body;
  let bm = body.match(/^\*\*([A-Za-z0-9][A-Za-z0-9./-]*)\*\*\s*(.*)$/);
  if (bm) {
    id = bm[1];
    title = bm[2];
  } else {
    bm = body.match(/^\*\*([A-Za-z0-9][A-Za-z0-9./-]*)\s+(.*)$/);
    if (bm) {
      id = bm[1];
      title = bm[2];
    } else {
      bm = body.match(/^([A-Za-z0-9][A-Za-z0-9./-]*)\s+(.*)$/);
      if (bm && bm[1].includes('-')) {
        id = bm[1];
        title = bm[2];
      }
    }
  }
  // Every real register id is uppercase (W3-01, F-HUB-2, BE-PURCH-FIX, QA-ISOLATION).
  // Anything with a lowercase letter is prose from a gate checklist, not a ticket.
  if (!id || /[a-z]/.test(id)) continue;

  const flat = plain(title);
  rows.push({
    id,
    kind: 'task',
    wave,
    title: id + ' \u2014 ' + shorten(flat, 100),
    status: STATE[m[1]],
    desc: [flat, ...cont.map(plain)].join('\n\n'),
    line: ln,
    section: 'section 4 Wave task register',
  });
}

// ---- 2. technical debt (section 5) ---------------------------------------
const debt = sec((t) => /^5\./.test(t));
for (const [ln, text] of range(debt)) {
  const m = text.match(/^\|\s*(\u2705\s*)?(D-\d+[a-z]?)\s*\|(.+)$/u);
  if (!m) continue;
  const cells = m[3]
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  const item = plain(cells[0] || '');
  // Only a tick in the ID CELL marks the item resolved. A tick inside the prose
  // means some sub-part is done (D-02: "4 of 5 copies still to retire (auth \u2705 done)").
  const resolved = Boolean(m[1]) || /\bRESOLVED\b/i.test(item);
  rows.push({
    id: m[2],
    kind: 'debt',
    wave: null,
    title: m[2] + ' \u2014 ' + shorten(item, 100),
    status: resolved ? 'Done' : 'Backlog',
    desc: cells.map(plain).join('\n\n'),
    line: ln,
    section: 'section 5 Technical debt register',
  });
}

// ---- 3. risks (section 7) ------------------------------------------------
const risk = sec((t) => /^7\./.test(t));
for (const [ln, text] of range(risk)) {
  const m = text.match(/^\|\s*\*{0,2}(RISK-[A-Z0-9]+|BUDGET)\*{0,2}\s*\|(.+)$/);
  if (!m) continue;
  const cells = m[2]
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  rows.push({
    id: m[1],
    kind: 'risk',
    wave: null,
    title: m[1] + ' \u2014 ' + shorten(plain(cells[0] || ''), 100),
    status: 'Todo',
    desc: cells.map(plain).join('\n\n'),
    line: ln,
    section: 'section 7 Risks needing a human decision',
  });
}

// ---- 4. blockers named in ### headers across sections 1a / 2 / 3 ---------
const seen = new Set();
for (const s of secs) {
  if (!/^(1a\.|2\.|3\.)/.test(s.title)) continue;
  for (const [ln, text] of range(s)) {
    const h = text.match(/^### (.+)/);
    if (!h) continue;
    const raw = h[1];
    const idm = raw.match(/\b(B-\d+[a-z]?|W\d-\d+|A-\d+)\b/);
    if (!idm) continue;
    const id = idm[1];
    if (seen.has(id)) continue; // newest mention is highest in the file; first wins
    seen.add(id);

    const done = /\u2705/u.test(raw) || /\bRESOLVED\b|\bCLOSED\b|\bFIXED\b/i.test(raw);
    const inprog = /\u{1F504}/u.test(raw) || /IN PROGRESS|PARTIAL/i.test(raw);

    const body = [];
    let j = ln; // ln is 1-based, so lines[ln] is the line AFTER the header
    while (j < s.end && !/^#{2,3} /.test(lines[j])) {
      if (lines[j].trim()) body.push(plain(lines[j]));
      j++;
      // Generous cap: the long blocker writeups run well past 30 lines and were
      // being cut mid-sentence. Only a runaway section should ever hit this.
      if (body.length > 200) break;
    }
    const heading = plain(
      raw.replace(/^[\u2705\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{1F504}\u{1F680}\s]+/u, ''),
    );
    rows.push({
      id,
      kind: 'blocker',
      wave: null,
      title:
        id +
        ' \u2014 ' +
        shorten(heading.replace(new RegExp('^' + id + '\\s*[\u2014-]*\\s*'), ''), 100),
      status: done ? 'Done' : inprog ? 'In Progress' : 'Todo',
      desc: body.join('\n\n'),
      line: ln,
      section: 'section ' + s.title,
    });
  }
}

// ---- 5. owner-blocked A-items from the section 1a table ------------------
const s1a = sec((t) => /^1a\./.test(t));
for (const [ln, text] of range(s1a)) {
  const m = text.match(
    /^\|\s*(?:[\u2705\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F7E2}]\s*)?(A-\d+)\s*\|(.+)$/u,
  );
  if (!m || seen.has(m[1])) continue;
  seen.add(m[1]);
  const cells = m[2]
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  rows.push({
    id: m[1],
    kind: 'owner-blocked',
    wave: null,
    title: m[1] + ' \u2014 ' + shorten(plain(cells[0] || ''), 100),
    status: /\u2705/u.test(text) || /\bCLOSED\b/i.test(cells[0] || '') ? 'Done' : 'Todo',
    desc: cells.map(plain).join('\n\n'),
    line: ln,
    section: 'section 1a Blocked on the owner',
  });
}

// ---- dedupe: same legacy id in two sections -> keep the fuller writeup ----
const byId = new Map();
const merged = [];
for (const r of rows) {
  const prev = byId.get(r.id);
  if (!prev) {
    byId.set(r.id, r);
    merged.push(r);
    continue;
  }
  // keep whichever carries more detail; fold the loser in as a cross-reference
  const keep = r.desc.length > prev.desc.length ? r : prev;
  const drop = keep === r ? prev : r;
  keep.desc +=
    '\n\nAlso recorded at ' +
    drop.section +
    ', line ' +
    drop.line +
    ' (status there: ' +
    drop.status +
    ').';
  if (keep !== prev) {
    merged[merged.indexOf(prev)] = keep;
    byId.set(r.id, keep);
  }
}
rows.length = 0;
rows.push(...merged);

// ---- emit CSV ------------------------------------------------------------
const PRIO = { blocker: '1', 'owner-blocked': '2', risk: '2', task: '3', debt: '4' };
const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

// `--json <kinds>` emits structured rows for the MCP path instead of a CSV,
// e.g. `--json blocker,debt,risk` for the items with no Linear representation.
const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1) {
  const kinds = (process.argv[jsonFlag + 1] || '').split(',').filter(Boolean);
  const picked = rows.filter((r) => kinds.includes(r.kind));
  fs.writeFileSync(
    process.argv[2],
    JSON.stringify(
      picked.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        status: r.status,
        priority: Number(PRIO[r.kind]),
        labels: [r.kind, 'from-progress-md'],
        description:
          r.desc +
          '\n\n---\nImported from `' +
          SRC +
          '` ' +
          r.section +
          ', line ' +
          r.line +
          '. Legacy id **' +
          r.id +
          '**.',
      })),
      null,
      2,
    ),
  );
  console.log('json rows=' + picked.length + ' kinds=' + kinds.join(','));
  process.exit(0);
}

const out = [['Title', 'Description', 'Status', 'Priority', 'Labels'].join(',')];
for (const r of rows) {
  const labels = [
    r.kind,
    r.wave ? r.wave.toLowerCase().replace(/\s+/g, '-') : null,
    'from-progress-md',
  ]
    .filter(Boolean)
    .join(';');
  const desc =
    r.desc +
    '\n\n---\nImported from `' +
    SRC +
    '` ' +
    r.section +
    ', line ' +
    r.line +
    '. Legacy id **' +
    r.id +
    '**.';
  out.push([esc(r.title), esc(desc), esc(r.status), esc(PRIO[r.kind]), esc(labels)].join(','));
}
fs.writeFileSync(process.argv[2], out.join('\n') + '\n');

const by = (k) => rows.filter((r) => r.kind === k).length;
const st = (k) => rows.filter((r) => r.status === k).length;
console.log(
  'rows=' +
    rows.length +
    '  task=' +
    by('task') +
    ' blocker=' +
    by('blocker') +
    ' debt=' +
    by('debt') +
    ' risk=' +
    by('risk') +
    ' owner=' +
    by('owner-blocked'),
);
console.log(
  'Done=' +
    st('Done') +
    ' InProgress=' +
    st('In Progress') +
    ' Todo=' +
    st('Todo') +
    ' Backlog=' +
    st('Backlog'),
);
const ids = rows.map((r) => r.id);
const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
if (dup.length) console.log('DUPLICATE IDS: ' + dup.join(' '));
