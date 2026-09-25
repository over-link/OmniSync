/**
 * public/js/chips.js
 * Email "chip" (bubble) input, shared by the Team page ("Add someone") and
 * License Administration ("Add license admin"). Type or paste addresses —
 * a whole list from a spreadsheet, Word doc or email "To:" field, however
 * it's separated — and each becomes its own removable bubble, so it's
 * unambiguous exactly who's queued before clicking Add.
 *
 * Enter, comma or semicolon turns what's typed into a bubble; Backspace in
 * an empty box removes the last one; anything half-typed becomes a bubble
 * when focus leaves. Addresses are shown as text, never as HTML.
 *
 * createEmailChipInput({ box, list, input }) → {
 *   take()  — turns anything half-typed into a bubble, returns every email
 *   clear() — removes all bubbles
 * }
 */
function createEmailChipInput({ box, list, input }) {
  let emails = [];

  // Splits on commas, semicolons, and any whitespace (newlines included).
  const parse = (raw) => raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

  function render() {
    list.innerHTML = '';
    emails.forEach((email, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = email;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.title = 'Remove';
      remove.setAttribute('aria-label', `Remove ${email}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        emails.splice(i, 1);
        render();
      });
      chip.appendChild(remove);
      list.appendChild(chip);
    });
  }

  // Adds every email parsed out of `raw`, deduped against what's queued.
  function addFromText(raw) {
    for (const email of parse(raw)) {
      if (!emails.includes(email)) emails.push(email);
    }
    render();
  }

  function commitTyped() {
    if (input.value.trim()) addFromText(input.value);
    input.value = '';
  }

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    addFromText(e.clipboardData.getData('text'));
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      commitTyped();
    } else if (e.key === 'Backspace' && !input.value && emails.length) {
      emails.pop();
      render();
    }
  });
  input.addEventListener('blur', commitTyped);
  box.addEventListener('click', (e) => {
    if (e.target === box || e.target === list) input.focus();
  });

  return {
    take() {
      commitTyped();
      return [...emails];
    },
    clear() {
      emails = [];
      render();
    },
  };
}
window.createEmailChipInput = createEmailChipInput;
