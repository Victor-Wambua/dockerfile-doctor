import type { FileKind, Finding, Severity } from '../../src/core/index.js';
import { applyEdits, detectKind, fixToFixpoint, getRule, lint } from '../../src/core/index.js';

interface Sample {
  id: string;
  label: string;
  kind: FileKind;
  text: string;
}
declare const __SAMPLES__: Sample[];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const code = $<HTMLTextAreaElement>('code');
const editor = $('editor');
const gutter = $('gutter');
const marks = $('marks');
const summary = $('summary');
const list = $('findings');
const tally = $('tally');
const srcMeta = $('srcmeta');
const statusEl = $('status');
const heading = $('fi-h');
const fixAllBtn = $<HTMLButtonElement>('fixall');
const undoBtn = $<HTMLButtonElement>('undo');
const sampleSel = $<HTMLSelectElement>('sample');

let kindChoice: 'auto' | FileKind = 'auto';
let findings: Finding[] = [];
let shown: Record<Severity, boolean> = { error: true, warn: true, info: true };
let history: string[] = [];
let activeLine = 0;
let timer: number | undefined;
let sayTimer: number | undefined;
let showAll = false;
const openWhy = new Set<string>();
const LIST_CAP = 150;

const SEV_LABEL: Record<Severity, string> = { error: 'Error', warn: 'Warning', info: 'Info' };
const SEV_ORDER: Severity[] = ['error', 'warn', 'info'];

function currentKind(): FileKind {
  return kindChoice === 'auto' ? detectKind(undefined, code.value) : kindChoice;
}

function kindName(kind: FileKind): string {
  return kind === 'compose' ? 'compose file' : 'Dockerfile';
}

function lineHeightPx(): number {
  const lh = Number.parseFloat(getComputedStyle(code).lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : 22.4;
}

function offsetOf(line: number, column: number): number {
  const lines = code.value.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += (lines[i] as string).length + 1;
  return off + column - 1;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(kid);
  return node;
}

function marker(sev: Severity): HTMLElement {
  return el('i', { class: `mk mk-${sev}`, 'aria-hidden': 'true' });
}

/** Size the editor to its content, within the limits set in CSS. */
function fitEditor(lineCount: number): void {
  const px = Math.ceil(lineCount * lineHeightPx() + 24);
  editor.style.setProperty('--content-h', `${px}px`);
}

function renderGutter(): void {
  const lineCount = code.value.split('\n').length;
  fitEditor(lineCount);
  const worst = new Map<number, Severity>();
  for (const f of findings) {
    for (let l = f.line; l <= Math.max(f.line, f.endLine); l++) {
      const cur = worst.get(l);
      if (!cur || SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(cur)) worst.set(l, f.severity);
    }
  }
  const g = document.createDocumentFragment();
  const m = document.createDocumentFragment();
  for (let i = 1; i <= lineCount; i++) {
    const sev = worst.get(i);
    const d = el('div', { text: String(i) });
    if (sev) d.dataset.sev = sev;
    if (i === activeLine) d.classList.add('g-active');
    g.append(d);
    m.append(
      el('div', { class: `${sev ? `m-${sev}` : ''}${i === activeLine ? ' m-active' : ''}` }),
    );
  }
  gutter.replaceChildren(g);
  marks.replaceChildren(m);
  syncScroll();
}

function syncScroll(): void {
  gutter.scrollTop = code.scrollTop;
  marks.style.transform = `translateY(${-code.scrollTop}px)`;
}

function visible(): Finding[] {
  return findings.filter((f) => shown[f.severity]);
}

function renderSummary(): void {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const nodes: Node[] = [];
  for (const sev of SEV_ORDER) {
    const noun =
      sev === 'info' ? 'info' : `${SEV_LABEL[sev].toLowerCase()}${counts[sev] === 1 ? '' : 's'}`;
    const b = el('button', {
      type: 'button',
      class: `sevbtn ${sev}`,
      'aria-pressed': String(shown[sev]),
    });
    b.append(
      el('b', { class: 'n', text: String(counts[sev]) }),
      el('span', { class: 'lbl' }, marker(sev), noun),
    );
    b.addEventListener('click', () => {
      shown = { ...shown, [sev]: !shown[sev] };
      showAll = false;
      renderSummary();
      renderList();
    });
    nodes.push(b);
  }
  summary.replaceChildren(...nodes);
}

function snippet(text: string): HTMLElement {
  return el('pre', { class: 'snip', text });
}

function renderList(): void {
  const items = visible();
  if (items.length === 0) {
    const msg =
      code.value.trim() === ''
        ? ['Nothing to check yet', 'Paste a Dockerfile or compose file, or pick a sample.']
        : findings.length === 0
          ? notCompose()
            ? [
                'No services found',
                'Nothing was checked. A compose file needs a top-level "services:" key. Choose Dockerfile or Auto if this is a Dockerfile.',
              ]
            : [
                'No problems found',
                'No findings at any severity. Pick a bad sample to see the rules at work.',
              ]
          : ['All findings are hidden', 'Turn a severity back on with the buttons above.'];
    list.replaceChildren(
      el('li', { class: 'empty' }, el('strong', { text: msg[0] as string }), msg[1] as string),
    );
    return;
  }
  const out: Node[] = [];
  const slice = showAll ? items : items.slice(0, LIST_CAP);
  for (const f of slice) {
    const rule = getRule(f.ruleId);
    const key = `${f.ruleId}-${f.line}-${f.column}`;
    const li = el('li', { class: `finding ${f.severity}` });
    const jump = el('button', { type: 'button', class: 'jump' });
    jump.append(
      el(
        'span',
        { class: 'meta' },
        el('span', { class: `sev ${f.severity}` }, marker(f.severity), SEV_LABEL[f.severity]),
        el('span', { class: 'rid', text: f.ruleId }),
        el('span', { text: `line ${f.line}, col ${f.column}` }),
        el('span', { text: f.category }),
      ),
      el('span', { class: 'msg', text: f.message }),
      el('span', { class: 'sr', text: ' Show this line in the source.' }),
    );
    jump.addEventListener('click', () => jumpTo(f));
    li.append(jump);
    const acts = el('div', { class: 'acts' });
    if (f.fix) {
      const fx = el('button', {
        type: 'button',
        class: 'primary',
        text: `Fix: ${f.fix.description}`,
      });
      fx.addEventListener('click', () => applyOne(f));
      acts.append(fx);
    }
    let panel: HTMLElement | undefined;
    if (rule) {
      const panelId = `why-${key}`;
      const isOpen = openWhy.has(key);
      const toggle = el('button', {
        type: 'button',
        class: 'disclose',
        'aria-expanded': String(isOpen),
        'aria-controls': panelId,
        'aria-label': `Why it matters, ${f.ruleId}`,
      });
      toggle.append(el('i', { class: 'chev', 'aria-hidden': 'true' }), 'Why it matters');
      panel = el(
        'div',
        { class: 'why-panel', id: panelId },
        el('p', { class: 'why', text: rule.why }),
        el(
          'div',
          { class: 'ba' },
          el('figure', {}, el('figcaption', { text: 'Before' }), snippet(rule.before)),
          el('figure', {}, el('figcaption', { text: 'After' }), snippet(rule.after)),
        ),
      );
      panel.hidden = !isOpen;
      const p = panel;
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        p.hidden = !open;
        if (open) openWhy.add(key);
        else openWhy.delete(key);
      });
      acts.append(toggle);
    }
    acts.append(
      el('a', {
        class: 'rulelink',
        href: `./rules.html#${f.ruleId}`,
        text: 'Rule page',
        'aria-label': `Rule page for ${f.ruleId}`,
      }),
    );
    li.append(acts);
    if (panel) li.append(panel);
    out.push(li);
  }
  if (items.length > slice.length) {
    const more = el('button', {
      type: 'button',
      class: 'more',
      text: `Show all ${items.length} findings (showing ${slice.length})`,
    });
    more.addEventListener('click', () => {
      showAll = true;
      renderList();
    });
    out.push(el('li', { class: 'more-row' }, more));
  }
  list.replaceChildren(...out);
}

function jumpTo(f: Finding): void {
  activeLine = f.line;
  const start = offsetOf(f.line, f.column);
  const end = offsetOf(f.endLine, f.endColumn);
  renderGutter();
  code.focus({ preventScroll: true });
  code.setSelectionRange(start, Math.max(start, end));
  const lh = lineHeightPx();
  code.scrollTop = Math.max(0, (f.line - 4) * lh);
  syncScroll();
  editor.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  say(`Line ${f.line} selected in the source: ${f.ruleId}.`);
}

function setText(next: string, remember = true): void {
  if (remember) {
    history.push(code.value);
    if (history.length > 50) history.shift();
  }
  code.value = next;
  activeLine = 0;
  run();
}

function applyOne(f: Finding): void {
  if (!f.fix) return;
  setText(applyEdits(code.value, f.fix.edits));
  say(`Applied: ${f.fix.description}. ${remaining()}`);
  undoBtn.focus();
}

function count(): string {
  const n = findings.length;
  return n === 0 ? 'No findings.' : `${n} finding${n === 1 ? '' : 's'}.`;
}

function remaining(): string {
  const n = findings.length;
  return n === 0 ? 'No findings left.' : `${n} finding${n === 1 ? '' : 's'} left.`;
}

/** A compose file is a mapping with a services key; anything else gets a hint, not a clean bill. */
function notCompose(): boolean {
  return (
    currentKind() === 'compose' && code.value.trim() !== '' && !/^services\s*:/m.test(code.value)
  );
}

/** Announce a result in the live region. Clearing first makes repeated messages re-announce. */
function say(msg: string): void {
  window.clearTimeout(sayTimer);
  statusEl.textContent = '';
  sayTimer = window.setTimeout(() => {
    statusEl.textContent = msg;
  }, 60);
}

function run(): void {
  const kind = currentKind();
  const res = lint(code.value, { kind, file: kind === 'compose' ? 'compose.yaml' : 'Dockerfile' });
  findings = res.findings;
  const fixable = findings.filter((f) => f.fix).length;
  fixAllBtn.disabled = fixable === 0;
  fixAllBtn.textContent = fixable ? `Apply all safe fixes (${fixable})` : 'Apply all safe fixes';
  undoBtn.disabled = history.length === 0;
  renderSummary();
  renderList();
  renderGutter();
  const n = findings.length;
  const lines = code.value === '' ? 0 : code.value.split('\n').length;
  srcMeta.textContent =
    code.value.trim() === ''
      ? 'Empty.'
      : `${kindChoice === 'auto' ? 'Detected as' : 'Checked as'} ${kindName(kind)}. ${lines} line${lines === 1 ? '' : 's'}.`;
  tally.textContent =
    code.value.trim() === ''
      ? ''
      : notCompose()
        ? 'Nothing was checked.'
        : `${n} finding${n === 1 ? '' : 's'}${res.suppressed ? `, ${res.suppressed} suppressed by ignore comments` : ''}.`;
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, 120);
}

code.addEventListener('input', () => {
  // Undo only covers fixes; once the text is edited by hand, a stale snapshot would drop that edit.
  history = [];
  activeLine = 0;
  sampleSel.value = '';
  statusEl.textContent = '';
  schedule();
});
code.addEventListener('scroll', syncScroll, { passive: true });
fixAllBtn.addEventListener('click', () => {
  const kind = currentKind();
  const out = fixToFixpoint(code.value, (t) => lint(t, { kind }).findings);
  if (out.text === code.value) return;
  setText(out.text);
  say(`Applied ${out.applied.length} fix${out.applied.length === 1 ? '' : 'es'}. ${remaining()}`);
  undoBtn.focus();
});

undoBtn.addEventListener('click', () => {
  const prev = history.pop();
  if (prev === undefined) return;
  setText(prev, false);
  say(`Undid the last fix. ${remaining()}`);
  if (!fixAllBtn.disabled) fixAllBtn.focus();
  else if (!undoBtn.disabled) undoBtn.focus();
  else heading.focus();
});

for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
  b.addEventListener('click', () => {
    kindChoice = b.dataset.kind as 'auto' | FileKind;
    for (const o of document.querySelectorAll<HTMLButtonElement>('.seg button'))
      o.setAttribute('aria-pressed', String(o === b));
    history = [];
    run();
    say(
      `Checking as ${kindName(currentKind())}. ${notCompose() ? 'No services key found, so nothing was checked.' : count()}`,
    );
  });
}

sampleSel.append(el('option', { value: '', text: 'Choose a sample' }));
const groups = [
  ['Bad examples', __SAMPLES__.filter((s) => s.id.startsWith('bad/'))],
  ['Good examples', __SAMPLES__.filter((s) => s.id.startsWith('good/'))],
] as const;
for (const [label, items] of groups) {
  const og = el('optgroup', { label });
  for (const s of items) og.append(el('option', { value: s.id, text: s.label }));
  sampleSel.append(og);
}
sampleSel.addEventListener('change', () => {
  const s = __SAMPLES__.find((x) => x.id === sampleSel.value);
  if (!s) return;
  history = [];
  openWhy.clear();
  showAll = false;
  kindChoice = 'auto';
  for (const o of document.querySelectorAll<HTMLButtonElement>('.seg button'))
    o.setAttribute('aria-pressed', String(o.dataset.kind === 'auto'));
  setText(s.text, false);
  code.scrollTop = 0;
  syncScroll();
  say(`Loaded ${s.label}. ${count()}`);
});

// Start with the most instructive bad example so the page is never empty.
const first = __SAMPLES__.find((s) => s.id === 'bad/01-node-everything-wrong');
code.value = first?.text ?? 'FROM node\nCMD node server.js\n';
if (first) sampleSel.value = first.id;
run();
