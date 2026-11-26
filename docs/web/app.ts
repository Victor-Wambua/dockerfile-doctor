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
const gutter = $('gutter');
const marks = $('marks');
const summary = $('summary');
const list = $('findings');
const statusEl = $('status');
const fixAllBtn = $<HTMLButtonElement>('fixall');
const undoBtn = $<HTMLButtonElement>('undo');
const sampleSel = $<HTMLSelectElement>('sample');
const LINE_HEIGHT = 13.5 * 1.6;

let kindChoice: 'auto' | FileKind = 'auto';
let findings: Finding[] = [];
let shown: Record<Severity, boolean> = { error: true, warn: true, info: true };
let history: string[] = [];
let activeLine = 0;
let timer: number | undefined;

const SEV_LABEL: Record<Severity, string> = { error: 'Error', warn: 'Warning', info: 'Info' };
const SEV_ORDER: Severity[] = ['error', 'warn', 'info'];

function currentKind(): FileKind {
  return kindChoice === 'auto' ? detectKind(undefined, code.value) : kindChoice;
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

function renderGutter(): void {
  const lineCount = code.value.split('\n').length;
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
    const b = el('button', {
      type: 'button',
      class: `chip ${sev}`,
      'aria-pressed': String(shown[sev]),
    });
    b.append(
      el('b', { text: String(counts[sev]) }),
      ` ${SEV_LABEL[sev].toLowerCase()}${counts[sev] === 1 || sev === 'info' ? '' : 's'}`,
    );
    b.addEventListener('click', () => {
      shown = { ...shown, [sev]: !shown[sev] };
      renderSummary();
      renderList();
    });
    nodes.push(b);
  }
  if (findings.length === 0 && code.value.trim() !== '')
    nodes.push(el('span', { class: 'ok-msg', text: 'No problems found' }));
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
        ? ['Nothing to check yet', 'Paste a Dockerfile or pick a sample.']
        : findings.length === 0
          ? ['Clean', 'No findings at any severity. Try a bad sample to see the rules at work.']
          : ['All findings hidden', 'Re-enable a severity with the chips above.'];
    list.replaceChildren(
      el('li', { class: 'empty' }, el('strong', { text: msg[0] as string }), msg[1] as string),
    );
    return;
  }
  const out: Node[] = [];
  for (const f of items) {
    const rule = getRule(f.ruleId);
    const li = el('li', { class: `finding ${f.severity}` });
    const jump = el('button', {
      type: 'button',
      class: 'jump',
      'aria-label': `${SEV_LABEL[f.severity]} ${f.ruleId} at line ${f.line}: ${f.message}`,
    });
    jump.append(
      el(
        'span',
        { class: 'meta' },
        el('span', { class: `sev ${f.severity}`, text: SEV_LABEL[f.severity] }),
        el('span', { class: 'rid', text: f.ruleId }),
        el('span', { text: `line ${f.line}, col ${f.column}` }),
        el('span', { class: 'tag', text: f.category }),
      ),
      el('span', { class: 'msg', text: f.message }),
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
    acts.append(
      el('a', {
        class: 'btn',
        href: `./rules.html#${f.ruleId}`,
        text: 'Rule page',
        style: 'display:inline-flex;align-items:center;text-decoration:none',
      }),
    );
    if (rule) {
      const d = el('details');
      d.append(
        el('summary', { text: 'Why it matters' }),
        el('p', { class: 'why', text: rule.why }),
        el(
          'div',
          { class: 'ba' },
          el('figure', {}, el('figcaption', { text: 'Before' }), snippet(rule.before)),
          el('figure', {}, el('figcaption', { text: 'After' }), snippet(rule.after)),
        ),
      );
      acts.append(d);
    }
    li.append(acts);
    out.push(li);
  }
  list.replaceChildren(...out);
}

function jumpTo(f: Finding): void {
  activeLine = f.line;
  const start = offsetOf(f.line, f.column);
  const end = offsetOf(f.endLine, f.endColumn);
  code.focus();
  code.setSelectionRange(start, Math.max(start, end));
  code.scrollTop = Math.max(0, (f.line - 4) * LINE_HEIGHT);
  renderGutter();
}

function setText(next: string, remember = true): void {
  if (remember) {
    history.push(code.value);
    if (history.length > 50) history.shift();
  }
  code.value = next;
  run();
}

function applyOne(f: Finding): void {
  if (!f.fix) return;
  setText(applyEdits(code.value, f.fix.edits));
  say(`Applied: ${f.fix.description}.`);
}

function say(msg: string): void {
  statusEl.textContent = msg;
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
  say(
    code.value.trim() === ''
      ? ''
      : `${n} finding${n === 1 ? '' : 's'} in ${kind === 'compose' ? 'compose file' : 'Dockerfile'} (${res.suppressed} suppressed by ignores).`,
  );
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, 120);
}

code.addEventListener('input', schedule);
code.addEventListener('scroll', syncScroll, { passive: true });
fixAllBtn.addEventListener('click', () => {
  const kind = currentKind();
  const out = fixToFixpoint(code.value, (t) => lint(t, { kind }).findings);
  if (out.text === code.value) return;
  setText(out.text);
  say(`Applied ${out.applied.length} fix${out.applied.length === 1 ? '' : 'es'}.`);
});

undoBtn.addEventListener('click', () => {
  const prev = history.pop();
  if (prev === undefined) return;
  setText(prev, false);
  say('Undid the last fix.');
});

for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
  b.addEventListener('click', () => {
    kindChoice = b.dataset.kind as 'auto' | FileKind;
    for (const o of document.querySelectorAll<HTMLButtonElement>('.seg button'))
      o.setAttribute('aria-pressed', String(o === b));
    run();
  });
}

sampleSel.append(el('option', { value: '', text: 'Load a sample...' }));
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
  kindChoice = 'auto';
  for (const o of document.querySelectorAll<HTMLButtonElement>('.seg button'))
    o.setAttribute('aria-pressed', String(o.dataset.kind === 'auto'));
  setText(s.text, false);
  code.scrollTop = 0;
  say(`Loaded ${s.label}.`);
});

// Start with the most instructive bad example so the page is never empty.
const first = __SAMPLES__.find((s) => s.id === 'bad/01-node-everything-wrong');
code.value = first?.text ?? 'FROM node\nCMD node server.js\n';
if (first) sampleSel.value = first.id;
run();
