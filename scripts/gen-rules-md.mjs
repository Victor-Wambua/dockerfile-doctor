// Writes docs/RULES.md from the rule metadata. `--check` fails when the committed file is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_RULES } from '../dist/index.js';
import { renderRulesMarkdown } from './lib/rules-page.mjs';

const target = fileURLToPath(new URL('../docs/RULES.md', import.meta.url));
const next = renderRulesMarkdown(ALL_RULES);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  if (current !== next) {
    console.error('docs/RULES.md is out of date. Run `npm run docs:rules` and commit the result.');
    process.exit(1);
  }
  console.log(`docs/RULES.md is up to date (${ALL_RULES.length} rules)`);
} else {
  writeFileSync(target, next);
  console.log(`wrote docs/RULES.md (${ALL_RULES.length} rules)`);
}
