/**
 * Heuristics for spotting credentials. Deliberately conservative: a name match alone is only a
 * signal when the value is a literal, and entropy only counts for long, token-shaped strings.
 */

const SECRET_NAME =
  /(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|APIKEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|SESSION_?KEY|CONSUMER_?KEY|PASS_?KEY|CREDENTIALS?|BEARER|(^|_)PASS$|(^|_)PWD$|DB_PASS)/i;

/** Suffixes that mean "this names a location or setting, not the secret itself". */
const NOT_A_SECRET_SUFFIX =
  /(_FILE|_PATH|_DIR|_URL|_URI|_ENDPOINT|_HOST|_PORT|_TTL|_EXPIRY|_EXPIRES|_LENGTH|_SIZE|_NAME|_ENABLED|_REQUIRED|_TYPE|_HEADER|_PREFIX|_REGEX|_ALGORITHM|_ALG|_LIFETIME|_TIMEOUT|_VERSION)$/i;

export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === 'PWD' || upper === 'OLDPWD') return false;
  if (NOT_A_SECRET_SUFFIX.test(upper)) return false;
  return SECRET_NAME.test(upper);
}

/** A value that clearly is not a literal secret (empty, a reference, or an obvious placeholder). */
export function isNonLiteral(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  if (v === '') return true;
  if (/^\$\{?[A-Za-z_]/.test(v) && !/[^${}A-Za-z0-9_:\-+]/.test(v)) return true;
  if (/^<[^>]*>$/.test(v)) return true;
  if (/^(x{3,}|\*{3,}|\.{3,}|-+|none|null|false|true|0|1|\/run\/secrets\/.*)$/i.test(v))
    return true;
  return false;
}

export interface PatternHit {
  kind: string;
  index: number;
  length: number;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'Stripe secret key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { kind: 'private key block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  {
    kind: 'JSON web token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: 'credentials embedded in a URL',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"$]+:[^/\s@'"$]{3,}@[^\s'"]+/i,
  },
];

export function findSecretPatterns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ kind, index: m.index, length: m[0].length });
  }
  return hits;
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, token-shaped, high-entropy value that is not obviously a checksum or a version. */
export function looksHighEntropy(value: string): boolean {
  const v = value.trim();
  if (v.length < 24 || v.length > 200) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(v)) return false;
  if (/^[0-9a-f]+$/i.test(v) && [32, 40, 56, 64, 96, 128].includes(v.length)) return false; // checksums
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
  return shannonEntropy(v) >= 4.0;
}
