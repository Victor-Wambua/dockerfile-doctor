// Builds the static site (playground + rule catalogue) into _site/.
// Run `npm run build` first: the rule metadata and the linter core come from dist/ and docs/web.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ALL_RULES } from '../dist/index.js';
import { renderRulesPage } from './lib/rules-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '_site');
const web = join(root, 'docs/web');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function samples() {
  const list = [];
  const strip = (t) => t.replace(/^# expect:.*\n/m, '');
  const bad = join(root, 'examples/bad');
  for (const f of readdirSync(bad).sort()) {
    const name = f.replace(/\.(Dockerfile|ya?ml)$/i, '');
    list.push({
      id: `bad/${name}`,
      label: name.replace(/^\d+-/, '').replace(/[-.]/g, ' '),
      kind: /\.ya?ml$/i.test(f) ? 'compose' : 'dockerfile',
      text: strip(readFileSync(join(bad, f), 'utf8')),
    });
  }
  for (const app of ['node', 'fastapi', 'laravel']) {
    list.push({
      id: `good/${app}`,
      label: `${app} (multi-stage, non-root)`,
      kind: 'dockerfile',
      text: readFileSync(join(root, 'examples/good', app, 'Dockerfile'), 'utf8'),
    });
  }
  list.push({
    id: 'good/laravel-compose',
    label: 'laravel compose file',
    kind: 'compose',
    text: readFileSync(join(root, 'examples/good/laravel/compose.yaml'), 'utf8'),
  });
  return list;
}

async function buildAll() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  await build({
    entryPoints: [join(web, 'app.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    outfile: join(out, 'assets/app.js'),
    define: { __SAMPLES__: JSON.stringify(samples()) },
    legalComments: 'none',
  });
  const subs = { '{{VERSION}}': pkg.version, '{{RULE_COUNT}}': String(ALL_RULES.length) };
  let index = readFileSync(join(web, 'index.html'), 'utf8');
  for (const [k, v] of Object.entries(subs)) index = index.replaceAll(k, v);
  writeFileSync(join(out, 'index.html'), index);
  writeFileSync(join(out, 'rules.html'), renderRulesPage(ALL_RULES, pkg.version));
  for (const f of ['style.css', 'logo.svg', 'rules.js']) cpSync(join(web, f), join(out, f));
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`site built in ${out} (${ALL_RULES.length} rules)`);
}

await buildAll();

if (process.argv.includes('--serve')) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 4170);
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
  };
  createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = readFileSync(join(out, p));
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
}
