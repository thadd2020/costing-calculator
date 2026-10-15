// Asks before destructive actions: <form data-confirm="Delete X?">.
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}

// Same for a single button: <button data-confirm-click="Remove X?">.
for (const button of document.querySelectorAll('[data-confirm-click]')) {
  button.addEventListener('click', (event) => {
    if (!window.confirm(button.dataset.confirmClick)) event.preventDefault();
  });
}
