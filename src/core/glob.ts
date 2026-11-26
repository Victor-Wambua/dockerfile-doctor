/** Minimal glob matcher: `**`, `*`, `?` and literal segments. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/');
  if (g.startsWith('./')) g = g.slice(2);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything.
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  let p = path.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  const re = globToRegExp(glob);
  if (re.test(p)) return true;
  // A bare directory name such as `legacy` or `legacy/` also matches everything beneath it.
  const dir = glob.replace(/\/+$/, '');
  if (!/[*?]/.test(dir)) return p === dir || p.startsWith(`${dir}/`);
  return false;
}
