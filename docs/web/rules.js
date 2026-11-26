// Filtering for the rule catalogue. Plain script, no dependencies.
(() => {
  const cards = [...document.querySelectorAll('.rule')];
  const q = document.getElementById('q');
  const count = document.getElementById('count');
  const none = document.getElementById('none');
  const auto = document.getElementById('auto');
  const active = { cat: new Set(), sev: new Set(), kind: new Set() };
  let fixOnly = false;

  const fixableIds = new Set(cards.filter((c) => c.querySelector('.fixable')).map((c) => c.id));

  function apply() {
    const term = q.value.trim().toLowerCase();
    let n = 0;
    for (const c of cards) {
      const ok =
        (!active.cat.size || active.cat.has(c.dataset.cat)) &&
        (!active.sev.size || active.sev.has(c.dataset.sev)) &&
        (!active.kind.size || active.kind.has(c.dataset.kind)) &&
        (!fixOnly || fixableIds.has(c.id)) &&
        (!term || c.dataset.text.includes(term));
      c.classList.toggle('hidden', !ok);
      if (ok) n++;
    }
    count.textContent = `Showing ${n} of ${cards.length} rules`;
    none.classList.toggle('hidden', n !== 0);
  }

  for (const b of document.querySelectorAll('[data-filter]')) {
    b.addEventListener('click', () => {
      const set = active[b.dataset.filter];
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      if (on) set.add(b.dataset.value);
      else set.delete(b.dataset.value);
      apply();
    });
  }
  auto.addEventListener('click', () => {
    fixOnly = auto.getAttribute('aria-pressed') !== 'true';
    auto.setAttribute('aria-pressed', String(fixOnly));
    apply();
  });
  q.addEventListener('input', apply);
})();
