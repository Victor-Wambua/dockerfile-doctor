// Generates the rule catalogue page from rule metadata, so docs cannot drift from the code.
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SEV = { error: 'Error', warn: 'Warning', info: 'Info' };
const CAT_ORDER = ['security', 'reproducibility', 'size', 'correctness', 'maintainability'];

export function renderRulesPage(rules, version) {
  const counts = { dockerfile: 0, compose: 0 };
  for (const r of rules) counts[r.kind]++;
  const cards = rules
    .map(
      (
        r,
      ) => `<article class="rule" id="${r.id}" data-kind="${r.kind}" data-sev="${r.severity}" data-cat="${r.category}" data-fix="${r.fixable ? '1' : '0'}" data-text="${esc(`${r.id} ${r.name} ${r.summary} ${r.explanation} ${r.why}`.toLowerCase())}">
  <h2><a href="#${r.id}"><span class="rid">${r.id}</span>${esc(r.summary)}</a></h2>
  <ul class="facts" aria-label="Details for ${r.id}">
    <li><span class="sev ${r.severity}"><i class="mk mk-${r.severity}" aria-hidden="true"></i>${SEV[r.severity]}</span></li>
    <li>${r.category}</li>
    <li>${r.kind === 'compose' ? 'Compose file' : 'Dockerfile'}</li>
    <li><code class="rname">${esc(r.name)}</code></li>
    ${r.fixable ? '<li class="fixable">Auto-fix available</li>' : ''}
  </ul>
  <div class="rule-body">
    <p>${esc(r.explanation)}</p>
    <p><span class="label">Why it matters.</span> ${esc(r.why)}</p>
    <div class="ba">
      <figure><figcaption>Before</figcaption><pre class="snip">${esc(r.before)}</pre></figure>
      <figure><figcaption>After</figcaption><pre class="snip">${esc(r.after)}</pre></figure>
    </div>
  </div>
</article>`,
    )
    .join('\n');
  const check = (filter, value, text) =>
    `<label class="check"><input type="checkbox" data-filter="${filter}" value="${value}" />${text}</label>`;
  const sevBoxes = ['error', 'warn', 'info'].map((s) => check('sev', s, SEV[s])).join('');
  const catBoxes = CAT_ORDER.map((c) => check('cat', c, c[0].toUpperCase() + c.slice(1))).join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dockerfile Doctor: rule catalogue</title>
    <meta name="description" content="Every Dockerfile Doctor rule with its severity, rationale and a before/after fix. Generated from the rule metadata." />
    <meta name="theme-color" content="#14213d" />
    <link rel="icon" href="./logo.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <a class="skip" href="#rules">Skip to the rules</a>
    <header class="top">
      <div class="wrap">
        <a class="brand" href="./"><img src="./logo.svg" alt="" width="32" height="32" />Dockerfile Doctor</a>
        <nav class="nav" aria-label="Main">
          <a href="./">Playground</a>
          <a href="./rules.html" aria-current="page">Rules (${rules.length})</a>
          <a href="https://github.com/Victor-Wambua/dockerfile-doctor">GitHub</a>
        </nav>
      </div>
    </header>
    <main id="main">
      <div class="wrap">
        <section class="intro">
          <h1>Rule catalogue</h1>
          <p>${rules.length} rules: ${counts.dockerfile} for Dockerfiles (<code>DD</code>) and ${counts.compose} for compose files (<code>DC</code>). Each id is stable, so it is safe to use in <code>.dockerdoctor.yml</code> and in <code># dd-ignore</code> comments. This page is generated from the rule metadata in the code.</p>
        </section>
        <form class="filters" role="search" aria-label="Filter rules" onsubmit="return false">
          <div class="search">
            <label class="field-label" for="q">Search rules</label>
            <input type="search" id="q" placeholder="Id, word or tool, for example DD003 or sudo" autocomplete="off" />
          </div>
          <fieldset><legend>Severity</legend>${sevBoxes}</fieldset>
          <fieldset><legend>Category</legend>${catBoxes}</fieldset>
          <fieldset><legend>Applies to</legend>${check('kind', 'dockerfile', 'Dockerfile')}${check('kind', 'compose', 'Compose file')}</fieldset>
          <fieldset><legend>Fix</legend><label class="check"><input type="checkbox" id="auto" />Auto-fix available</label></fieldset>
          <button type="button" id="clear" class="clear hidden">Clear all filters</button>
        </form>
        <p class="count" id="count" role="status" aria-live="polite">Showing ${rules.length} of ${rules.length} rules</p>
        <div class="rules" id="rules">
${cards}
        </div>
        <p class="empty hidden" id="none"><strong>No rules match</strong>Clear a filter or search for something else.</p>
      </div>
    </main>
    <footer>
      <div class="wrap"><p>Dockerfile Doctor ${esc(version)}, MIT licence. <a href="https://github.com/Victor-Wambua/dockerfile-doctor">Source and CLI</a>.</p></div>
    </footer>
    <script src="./rules.js" defer></script>
  </body>
</html>
`;
}

export function renderRulesMarkdown(rules) {
  const lines = [
    '# Rule reference',
    '',
    '<!-- Generated by `npm run docs:rules` from the rule metadata. Do not edit by hand. -->',
    '',
    `${rules.length} rules. Ids are stable. Use them in \`.dockerdoctor.yml\` and \`# dd-ignore\` comments.`,
    '',
    '| Id | Severity | Category | Fix | Summary |',
    '| --- | --- | --- | --- | --- |',
    ...rules.map(
      (r) =>
        `| [${r.id}](#${r.id.toLowerCase()}) | ${r.severity} | ${r.category} | ${r.fixable ? 'auto' : ''} | ${r.summary.replace(/\|/g, '\\|')} |`,
    ),
    '',
  ];
  for (const r of rules) {
    lines.push(
      `## ${r.id}`,
      '',
      `**${r.summary}**  `,
      `\`${r.name}\` · ${r.severity} · ${r.category} · ${r.kind === 'compose' ? 'compose file' : 'Dockerfile'}${r.fixable ? ' · auto-fixable' : ''}`,
      '',
      r.explanation,
      '',
      `**Why it matters.** ${r.why}`,
      '',
      'Before:',
      '',
      `\`\`\`${r.kind === 'compose' ? 'yaml' : 'dockerfile'}`,
      r.before,
      '```',
      '',
      'After:',
      '',
      `\`\`\`${r.kind === 'compose' ? 'yaml' : 'dockerfile'}`,
      r.after,
      '```',
      '',
    );
  }
  return `${lines.join('\n')}`;
}
