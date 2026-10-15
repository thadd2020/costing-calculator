// Ingredients: filter the list as you type (the search box also works without JavaScript).
const form = document.querySelector('[data-ing-filter]');
if (form) {
  const input = form.querySelector('input');
  const items = [...document.querySelectorAll('.ing-list > li')];
  const count = document.querySelector('[data-ing-count]');
  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const li of items) {
      li.hidden = q !== '' && !li.dataset.search.includes(q);
      if (!li.hidden) shown += 1;
    }
    if (count) count.textContent = shown;
  });
}
