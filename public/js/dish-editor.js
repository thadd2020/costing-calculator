// Dish editor: recalculates cost, GP, suggested and delivery prices as you type, using the
// same calc module as the server. The server recalculates again on save.
import {
  costDish, formatGBP, formatPct, poundsToPence, roundUpToStep, unitFamily, unitsForFamily,
} from '/static/calc.js';

const root = document.querySelector('[data-editor]');
const form = document.getElementById('dish-form');
const data = JSON.parse(document.getElementById('editor-data').dataset.json);
const linesList = root.querySelector('[data-lines]');

const labelOf = (i) => (i.supplier ? `${i.name} (${i.supplier})` : i.name);
const byLabel = new Map(data.ingredients.map((i) => [labelOf(i).toLowerCase(), i]));
const BASE_UNIT = { mass: 'g', volume: 'ml', each: 'each' };

// Same forgiving rules as the server: "£1,250.50" -> 1250.5; blank -> null.
// A comma is only a thousands separator, so "1,5" is refused rather than read as 15.
function readNumber(text) {
  let cleaned = String(text ?? '').trim().replace(/^£/, '').replace(/\s/g, '');
  if (cleaned.includes(',')) {
    if (!/^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(cleaned)) return null;
    cleaned = cleaned.replace(/,/g, '');
  }
  if (cleaned === '' || !/^-?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  return Number(cleaned);
}
const readPercent = (text) => {
  const n = readNumber(String(text ?? '').replace(/%\s*$/, ''));
  return n === null ? null : n / 100;
};
const field = (name) => form.elements.namedItem(name);

function readDish() {
  const price = readNumber(field('menu_price').value);
  return {
    type: form.querySelector('input[name="type"]:checked')?.value === 'drink' ? 'drink' : 'food',
    menu_price_inc_pence: price === null ? null : poundsToPence(price),
    yield_portions: field('yield_portions').value.trim() === '' ? 1 : readNumber(field('yield_portions').value),
    vat_rate: readPercent(field('vat_rate').value),
    target_gp: readPercent(field('target_gp').value),
    packaging: readNumber(field('packaging').value),
  };
}

function lineElements() {
  return [...linesList.querySelectorAll('[data-line]')];
}

// Keeps the unit dropdown to units that fit how the ingredient is bought.
function syncUnits(li, ingredient) {
  const select = li.querySelector('[data-unit]');
  const allowed = ingredient ? unitsForFamily(unitFamily(ingredient.pack_unit)) : ['g', 'kg', 'ml', 'l', 'each'];
  const current = select.value;
  for (const option of select.options) {
    // hidden alone is ignored by iOS Safari, so disable too.
    option.hidden = !allowed.includes(option.value);
    option.disabled = option.hidden;
  }
  if (!allowed.includes(current)) select.value = ingredient ? BASE_UNIT[unitFamily(ingredient.pack_unit)] : 'g';
}

function packText(i) {
  return `${formatGBP(i.pack_price_ex_vat)} for ${Number(i.pack_size).toLocaleString('en-GB', { maximumFractionDigits: 3 })} ${i.pack_unit}`;
}

function recalc() {
  const dish = readDish();
  const lines = [];
  const lineInfo = [];
  for (const li of lineElements()) {
    const label = li.querySelector('[data-ing-label]').value.trim();
    const qtyText = li.querySelector('[data-qty]').value;
    if (!label && !qtyText.trim()) { lineInfo.push({ li, skip: true }); continue; }
    const ingredient = byLabel.get(label.toLowerCase()) || null;
    lineInfo.push({ li, index: lines.length, ingredient, label });
    lines.push({ quantity: readNumber(qtyText), unit: li.querySelector('[data-unit]').value, ingredient });
  }

  const r = costDish(dish, lines, data.settings, data.channels);

  for (const info of lineInfo) {
    const costEl = info.li.querySelector('[data-line-cost]');
    const errEl = info.li.querySelector('[data-line-error]');
    const packEl = info.li.querySelector('[data-line-pack]');
    if (info.skip) { costEl.textContent = ''; errEl.textContent = ''; packEl.textContent = ''; continue; }
    const lr = r.lines[info.index];
    packEl.textContent = info.ingredient ? packText(info.ingredient) : '';
    costEl.textContent = lr.cost === null ? '' : formatGBP(lr.cost);
    if (!info.ingredient) errEl.textContent = info.label ? `"${info.label}" isn't in your ingredient list` : 'Choose an ingredient';
    else errEl.textContent = lr.error || '';
  }

  set('gpPct', formatPct(r.gpPct), true);
  set('gpMoney', formatGBP(r.gpMoney));
  set('trueCost', formatGBP(r.trueCost));
  set('priceEx', formatGBP(r.priceEx));
  set('targetGp', formatPct(r.rates.targetGp));
  set('markupPct', formatPct(r.markupPct));
  set('suggestedInc', formatGBP(r.suggested.incVat));
  set('errors', r.errors.length ? 'Cost incomplete: fix the ingredient lines marked in red.' : '');
  renderStatus(r.status);

  const useButton = root.querySelector('[data-use-suggested]');
  useButton.disabled = r.suggested.incVat === null;
  // Round up to the penny so the price never lands a fraction below target.
  useButton.dataset.price = r.suggested.incVat === null ? '' : roundUpToStep(r.suggested.incVat, 1).toFixed(2);

  r.delivery.forEach((d, i) => {
    const row = root.querySelector(`[data-channel="${i}"]`);
    if (!row) return;
    row.querySelector('[data-dout="incVat"]').textContent = formatGBP(d.incVat);
    row.querySelector('[data-dout="gpPct"]').textContent = formatPct(d.gpPct);
    row.querySelector('[data-dout="holdTargetIncVat"]').textContent = formatGBP(d.holdTargetIncVat);
  });
}

function set(key, text, animate = false) {
  const el = root.querySelector(`[data-out="${key}"]`);
  if (!el || el.textContent === text) return;
  el.textContent = text;
  if (animate) {
    el.classList.remove('changed');
    void el.offsetWidth; // restart the animation
    el.classList.add('changed');
  }
}

function renderStatus(status) {
  const holder = root.querySelector('[data-out="status"]');
  const span = document.createElement('span');
  span.className = `status status--${status.key}`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = status.icon;
  span.append(dot, status.label);
  holder.replaceChildren(span);
}

let lineCounter = lineElements().length;
function addLine() {
  const template = lineElements()[0];
  const li = template.cloneNode(true);
  const n = lineCounter++;
  for (const el of li.querySelectorAll('[id]')) {
    const label = li.querySelector(`label[for="${el.id}"]`);
    el.id = el.id.replace(/\d+$/, String(n));
    if (label) label.htmlFor = el.id;
  }
  li.querySelector('[data-ing-label]').value = '';
  li.querySelector('[data-qty]').value = '';
  syncUnits(li, null);
  li.querySelector('[data-unit]').value = 'g';
  linesList.append(li);
  li.querySelector('[data-ing-label]').focus();
  recalc();
}

linesList.addEventListener('input', (event) => {
  const li = event.target.closest('[data-line]');
  if (event.target.matches('[data-ing-label]')) {
    const ingredient = byLabel.get(event.target.value.trim().toLowerCase());
    syncUnits(li, ingredient || null);
  }
  recalc();
});
linesList.addEventListener('change', recalc);
linesList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-line]');
  if (!button) return;
  const li = button.closest('[data-line]');
  if (lineElements().length === 1) {
    li.querySelector('[data-ing-label]').value = '';
    li.querySelector('[data-qty]').value = '';
  } else {
    li.remove();
  }
  recalc();
});
root.querySelector('[data-add-line]').addEventListener('click', addLine);
root.querySelector('[data-use-suggested]').addEventListener('click', (event) => {
  if (!event.currentTarget.dataset.price) return;
  field('menu_price').value = event.currentTarget.dataset.price;
  dirty = true;
  recalc();
});
form.addEventListener('input', (event) => { if (!linesList.contains(event.target)) recalc(); });
form.addEventListener('change', (event) => { if (!linesList.contains(event.target)) recalc(); });

// Warn before leaving with unsaved changes.
let dirty = false;
form.addEventListener('input', () => { dirty = true; });
form.addEventListener('submit', () => { dirty = false; });
window.addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault(); });

for (const li of lineElements()) {
  const ingredient = byLabel.get(li.querySelector('[data-ing-label]').value.trim().toLowerCase());
  if (ingredient) {
    const select = li.querySelector('[data-unit]');
    const chosen = select.value;
    syncUnits(li, ingredient);
    if (unitFamily(chosen) === unitFamily(ingredient.pack_unit)) select.value = chosen;
  }
}
recalc();
