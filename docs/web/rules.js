// Filtering for the rule catalogue. Plain script, no dependencies.
(() => {
  const cards = [...document.querySelectorAll('.rule')];
  const q = document.getElementById('q');
  const count = document.getElementById('count');
  const none = document.getElementById('none');
  const auto = document.getElementById('auto');
  const clear = document.getElementById('clear');
  const boxes = [...document.querySelectorAll('input[data-filter]')];

  function apply() {
    const term = q.value.trim().toLowerCase();
    const active = { cat: new Set(), sev: new Set(), kind: new Set() };
    for (const b of boxes) if (b.checked) active[b.dataset.filter].add(b.value);
    let n = 0;
    for (const c of cards) {
      const ok =
        (!active.cat.size || active.cat.has(c.dataset.cat)) &&
        (!active.sev.size || active.sev.has(c.dataset.sev)) &&
        (!active.kind.size || active.kind.has(c.dataset.kind)) &&
        (!auto.checked || c.dataset.fix === '1') &&
        (!term || c.dataset.text.includes(term));
      c.classList.toggle('hidden', !ok);
      if (ok) n++;
    }
    count.textContent = `Showing ${n} of ${cards.length} rules`;
    none.classList.toggle('hidden', n !== 0);
    const any = term || auto.checked || boxes.some((b) => b.checked);
    clear.classList.toggle('hidden', !any);
  }

  for (const b of boxes) b.addEventListener('change', apply);
  auto.addEventListener('change', apply);
  q.addEventListener('input', apply);
  clear.addEventListener('click', () => {
    q.value = '';
    auto.checked = false;
    for (const b of boxes) b.checked = false;
    apply();
    q.focus();
  });
})();
