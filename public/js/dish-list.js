// Dish list: filter by name as you type, and apply the dropdowns/checkboxes immediately.
// Without JavaScript the same filters work through the Apply button.
const form = document.querySelector('[data-dish-filters]');
if (form) {
  form.querySelector('[data-hide-with-js]')?.setAttribute('hidden', '');
  const search = form.querySelector('#q');
  const items = [...document.querySelectorAll('.dish-list > li')];
  const empty = document.querySelector('[data-empty]');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const li of items) li.hidden = q !== '' && !li.dataset.name.includes(q);
    if (empty) empty.hidden = items.some((li) => !li.hidden);
  });
  for (const el of form.querySelectorAll('select, input[type="checkbox"]')) {
    el.addEventListener('change', () => form.requestSubmit());
  }
}
