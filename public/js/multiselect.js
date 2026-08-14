// Shared checkbox multi-select dropdown component, used by both the
// Issues page (filtering the board) and the Setup page (configuring
// auto-sync filter criteria) — same look, same interaction, one place to
// fix bugs instead of two copies drifting apart.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function multiSelectLabel(selected) {
  if (!selected.length) return 'All';
  if (selected.length <= 2) return selected.join(', ');
  return `${selected.length} selected`;
}

function closeAllMultiSelects() {
  document.querySelectorAll('.ms-panel').forEach((p) => p.classList.add('hidden'));
}
// Close open filter panels when clicking anywhere outside a filter
// dropdown (but not for clicks inside one, e.g. checking an option).
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ms')) closeAllMultiSelects();
});

// Renders a checkbox multi-select dropdown into `container`. `selected` is
// the current array of chosen values; `onChange(newSelectedArray)` fires
// whenever a checkbox is toggled — the caller owns the actual state (and
// decides what to do next: re-filter a board, just store it, etc.), this
// component only owns its own DOM/open-close/label behavior.
function renderMultiSelect(container, values, selected, onChange) {
  container.innerHTML = `
    <button type="button" class="ms-toggle">${escapeHtml(multiSelectLabel(selected))}</button>
    <div class="ms-panel hidden">${
      values.length
        ? values
            .map(
              (v) =>
                `<label class="ms-option"><input type="checkbox" value="${escapeHtml(v)}" ${
                  selected.includes(v) ? 'checked' : ''
                } /> ${escapeHtml(v)}</label>`
            )
            .join('')
        : '<div class="ms-empty">No options</div>'
    }</div>`;
  const toggle = container.querySelector('.ms-toggle');
  const panel = container.querySelector('.ms-panel');
  toggle.classList.toggle('active', selected.length > 0);
  toggle.addEventListener('click', () => {
    const isOpen = !panel.classList.contains('hidden');
    closeAllMultiSelects();
    if (!isOpen) panel.classList.remove('hidden');
  });
  panel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      // Mutate `selected` in place (not a new array) — every checkbox's
      // change handler closes over this same array reference, so if we
      // instead built a fresh array here, checking a second box before
      // any re-render would compute from the stale pre-first-check
      // array and silently drop the first selection. Mutating means
      // every checkbox in this render always reads the current state.
      if (cb.checked) {
        if (!selected.includes(cb.value)) selected.push(cb.value);
      } else {
        const idx = selected.indexOf(cb.value);
        if (idx !== -1) selected.splice(idx, 1);
      }
      toggle.textContent = multiSelectLabel(selected);
      toggle.classList.toggle('active', selected.length > 0);
      onChange(selected);
    });
  });
}
