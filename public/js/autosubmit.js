// Submits <form data-autosubmit> as soon as a dropdown changes.
for (const form of document.querySelectorAll('form[data-autosubmit]')) {
  form.querySelector('[data-hide-with-js]')?.setAttribute('hidden', '');
  for (const el of form.querySelectorAll('select')) el.addEventListener('change', () => form.requestSubmit());
}
