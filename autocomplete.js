// A small type-ahead list under a text field. Whatever is typed is always kept,
// so the list only ever helps; it never forces a choice.

let nextId = 0;

// 3: the whole value starts with the query, 2: a word starts with it, 1: it appears somewhere.
export function matchScore(value, query) {
  const v = value.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (v.startsWith(q)) return 3;
  const words = v.split(/[\s/&(),.-]+/);
  if (words.some((w) => w.startsWith(q))) return 2;
  if (v.includes(q)) return 1;
  const parts = q.split(/\s+/);
  return parts.length > 1 && parts.every((p) => words.some((w) => w.startsWith(p))) ? 1 : 0;
}

/**
 * getOptions(query) returns [{ value, note?, swatch?, mine? }], already filtered and sorted.
 * onPick(value) runs after an option is chosen.
 */
export function attachAutocomplete(input, { getOptions, onPick, renderSwatch }) {
  const listId = `ac-list-${++nextId}`;
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  let options = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function highlight(i) {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-${i}`);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function open() {
    options = getOptions(input.value);
    const typed = input.value.trim().toLowerCase();
    // Nothing to offer, or the field already holds the only match.
    if (!options.length || (options.length === 1 && options[0].value.toLowerCase() === typed)) {
      close();
      return;
    }
    list.innerHTML = '';
    options.forEach((o, i) => {
      const li = document.createElement('li');
      li.id = `${listId}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      if (renderSwatch) li.append(renderSwatch(o.value));
      const text = document.createElement('span');
      text.className = 'ac-text';
      text.textContent = o.value;
      li.append(text);
      if (o.note || o.mine) {
        const note = document.createElement('small');
        note.textContent = o.mine ? 'Used before' : o.note;
        li.append(note);
      }
      // pointerdown + preventDefault keeps the keyboard open and the field focused.
      li.addEventListener('pointerdown', (e) => e.preventDefault());
      li.addEventListener('click', () => pick(i));
      list.append(li);
    });
    list.hidden = false;
    list.scrollTop = 0;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  function pick(i) {
    const o = options[i];
    if (!o) return;
    input.value = o.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    if (onPick) onPick(o.value);
  }

  input.addEventListener('focus', () => {
    // Lift the field towards the top so the list isn't hidden behind the keyboard.
    setTimeout(() => input.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
    open();
  });
  input.addEventListener('input', (e) => {
    if (e.isTrusted) open();
  });
  input.addEventListener('blur', () => {
    // Match the catalog's spelling when someone types a known name in a different case.
    const typed = input.value.trim().toLowerCase();
    const same = typed && getOptions(input.value).find((o) => o.value.toLowerCase() === typed);
    if (same && same.value !== input.value) input.value = same.value;
    close();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown') open();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(Math.min(options.length - 1, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(-1, active - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return { open, close };
}
