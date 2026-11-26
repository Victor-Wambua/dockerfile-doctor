import { LineIndex } from '../core/text.js';
import type { Severity } from '../core/types.js';
import { ALL_RULES } from '../rules/index.js';
import type { FileReport } from './types.js';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  error: 'error',
  warn: 'warning',
  info: 'note',
};

/** GitHub maps this to Critical/High/Medium/Low in the Security tab for security-tagged rules. */
const SECURITY_SEVERITY: Record<Severity, string> = { error: '8.0', warn: '5.0', info: '3.0' };

/** FNV-1a, 32-bit. Stable, dependency-free fingerprint input. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

export function buildSarif(reports: FileReport[], version: string): Record<string, unknown> {
  const rules = ALL_RULES.map((r) => ({
    id: r.id,
    name: r.name
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(''),
    shortDescription: { text: r.summary },
    fullDescription: { text: `${r.explanation} ${r.why}` },
    help: {
      text: `${r.explanation}\n\nWhy it matters: ${r.why}\n\nBefore:\n${r.before}\n\nAfter:\n${r.after}`,
      markdown: `${r.explanation}\n\n**Why it matters.** ${r.why}\n\n**Before**\n\n\`\`\`${r.kind === 'compose' ? 'yaml' : 'dockerfile'}\n${r.before}\n\`\`\`\n\n**After**\n\n\`\`\`${r.kind === 'compose' ? 'yaml' : 'dockerfile'}\n${r.after}\n\`\`\``,
    },
    helpUri: `https://victor-wambua.github.io/dockerfile-doctor/rules.html#${r.id}`,
    defaultConfiguration: { level: LEVEL[r.severity] },
    properties: {
      category: r.category,
      tags: [r.category, r.kind],
      ...(r.category === 'security' ? { 'security-severity': SECURITY_SEVERITY[r.severity] } : {}),
    },
  }));
  const ruleIndex = new Map(ALL_RULES.map((r, i) => [r.id, i]));

  const results = reports.flatMap((rep) => {
    const idx = new LineIndex(rep.source);
    return rep.findings.map((f) => {
      const startOffset = idx.lineStart(f.line) + f.column - 1;
      const endOffset = idx.lineStart(f.endLine) + f.endColumn - 1;
      const snippet = rep.source.slice(startOffset, endOffset);
      const uri = rep.file.replace(/\\/g, '/').replace(/^\.\//, '');
      return {
        ruleId: f.ruleId,
        ruleIndex: ruleIndex.get(f.ruleId) ?? 0,
        level: LEVEL[f.severity],
        message: { text: f.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
              region: {
                startLine: f.line,
                startColumn: f.column,
                endLine: f.endLine,
                endColumn: f.endColumn,
                snippet: { text: snippet },
              },
            },
          },
        ],
        partialFingerprints: {
          'dockerfileDoctor/v1': fnv(
            `${f.ruleId}|${uri}|${idx.lineText(f.line).trim()}|${f.message}`,
          ),
        },
        ...(f.fix
          ? {
              fixes: [
                {
                  description: { text: f.fix.description },
                  artifactChanges: [
                    {
                      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
                      replacements: f.fix.edits.map((e) => ({
                        deletedRegion: { charOffset: e.start, charLength: e.end - e.start },
                        insertedContent: { text: e.text },
                      })),
                    },
                  ],
                },
              ],
            }
          : {}),
      };
    });
  });

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'dockerfile-doctor',
            version,
            semanticVersion: version,
            informationUri: 'https://github.com/Victor-Wambua/dockerfile-doctor',
            rules,
          },
        },
        results,
        columnKind: 'utf16CodeUnits',
        invocations: [{ executionSuccessful: true }],
      },
    ],
  };
}

export function renderSarif(reports: FileReport[], version: string): string {
  return `${JSON.stringify(buildSarif(reports, version), null, 2)}\n`;
}
