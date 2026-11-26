import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/engine.js';
import { buildSarif } from '../src/reporters/sarif.js';
import type { FileReport } from '../src/reporters/types.js';
import { ALL_RULES } from '../src/rules/index.js';

const Ajv = createRequire(import.meta.url)('ajv-draft-04');

// The official OASIS SARIF 2.1.0 JSON Schema (draft-04), vendored unmodified under tests/vendor.
const schema = JSON.parse(
  readFileSync(new URL('./vendor/sarif-schema-2.1.0.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(schema);

const FIX_ROOT = new URL('./fixtures/rules/', import.meta.url).pathname;
function allReports(): FileReport[] {
  const reports: FileReport[] = [];
  for (const id of readdirSync(FIX_ROOT)) {
    for (const f of readdirSync(join(FIX_ROOT, id)).filter((n) =>
      /\.(?:Dockerfile|yml)$/.test(n),
    )) {
      const source = readFileSync(join(FIX_ROOT, id, f), 'utf8');
      const file = `tests/fixtures/rules/${id}/${f}`;
      const res = lint(source, { file, kind: f.endsWith('.yml') ? 'compose' : 'dockerfile' });
      reports.push({
        file,
        kind: res.kind,
        findings: res.findings,
        suppressed: res.suppressed,
        source,
      });
    }
  }
  return reports;
}

describe('SARIF 2.1.0 output', () => {
  const reports = allReports();
  const sarif = buildSarif(reports, '0.1.0') as {
    runs: Array<{
      results: Array<Record<string, any>>;
      tool: { driver: { rules: Array<Record<string, any>> } };
    }>;
  };

  it('validates against the official schema', () => {
    const ok = validate(sarif);
    expect(validate.errors?.slice(0, 5) ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the validator really rejects broken documents', () => {
    expect(validate({ version: '2.1.0' })).toBe(false); // runs is required
    expect(validate({ version: '2.0.0', runs: [] })).toBe(false); // wrong version
    const broken = structuredClone(sarif);
    (broken.runs[0] as any).results[0].level = 'catastrophic';
    expect(validate(broken)).toBe(false);
    const noMsg = structuredClone(sarif);
    delete (noMsg.runs[0] as any).results[0].message;
    expect(validate(noMsg)).toBe(false);
  });

  it('lists every rule once, and each result points at its rule by index', () => {
    const run = sarif.runs[0];
    expect(run).toBeDefined();
    if (!run) return;
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(ALL_RULES.map((r) => r.id));
    expect(run.results.length).toBeGreaterThan(100);
    for (const r of run.results) {
      expect(run.tool.driver.rules[r.ruleIndex]?.id).toBe(r.ruleId);
    }
  });

  it('maps severities to SARIF levels and tags security rules with a security-severity', () => {
    const run = sarif.runs[0];
    if (!run) return;
    const byRule = new Map(run.tool.driver.rules.map((r) => [r.id, r]));
    expect(byRule.get('DD007')?.defaultConfiguration.level).toBe('error');
    expect(byRule.get('DD001')?.defaultConfiguration.level).toBe('warning');
    expect(byRule.get('DD002')?.defaultConfiguration.level).toBe('note');
    expect(byRule.get('DD007')?.properties['security-severity']).toBe('8.0');
    expect(byRule.get('DD024')?.properties['security-severity']).toBeUndefined();
  });

  it('uses 1-based, ordered regions and forward-slash relative URIs', () => {
    const run = sarif.runs[0];
    if (!run) return;
    for (const r of run.results) {
      const loc = r.locations[0].physicalLocation;
      expect(loc.artifactLocation.uri).not.toMatch(/^\/|\\/);
      expect(loc.region.startLine).toBeGreaterThanOrEqual(1);
      expect(loc.region.startColumn).toBeGreaterThanOrEqual(1);
      expect(loc.region.endLine).toBeGreaterThanOrEqual(loc.region.startLine);
      expect(typeof r.partialFingerprints['dockerfileDoctor/v1']).toBe('string');
    }
  });

  it('includes fixes with character-offset replacements', () => {
    const withFix = sarif.runs[0]?.results.find((r) => r.ruleId === 'DD005' && r.fixes);
    expect(withFix?.fixes[0].artifactChanges[0].replacements[0].insertedContent.text).toBe('COPY');
  });

  it('an empty run is still valid SARIF', () => {
    expect(validate(buildSarif([], '0.1.0'))).toBe(true);
  });
});
