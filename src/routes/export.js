import { Router } from 'express';
import { listIngredients, createSnapshot, listBackups, getBackup } from '../db/index.js';
import { costDishes } from '../costing.js';
import { TEMPLATE_COLUMNS } from '../import/parse.js';
import { toCsv, sendCsv } from '../csv.js';
import { formatQty } from '../format.js';
import { parseId } from '../input.js';

const stamp = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // 2026-10-15
const pct = (fraction) => (fraction === null || fraction === undefined ? '' : `${Number((fraction * 100).toFixed(4))}%`);
const money = (v) => (v === null || v === undefined ? '' : Number(v.toFixed(2)));

export default function exportRoutes({ db }) {
  const router = Router();

  router.get('/export', async (req, res) => {
    res.render('export', { title: 'Export and backup', backups: await listBackups(db) });
  });

  // Same columns as the import template, so export -> edit -> re-import works.
  router.get('/export/ingredients.csv', async (req, res) => {
    const rows = (await listIngredients(db)).map((i) => ({
      name: i.name, supplier: i.supplier, category: i.category, pack_size: i.pack_size, pack_unit: i.pack_unit,
      pack_price: i.pack_price_ex_vat, price_includes_vat: 'no', vat_rate: pct(i.vat_rate), waste_pct: pct(i.waste_pct),
    }));
    sendCsv(res, `ingredients-${stamp()}.csv`, toCsv(TEMPLATE_COLUMNS, rows));
  });

  router.get('/export/dishes.csv', async (req, res) => {
    const columns = ['name', 'type', 'active', 'menu_price_inc_vat', 'price_ex_vat', 'true_cost', 'gp', 'gp_pct', 'target_gp',
      'status', 'suggested_price_inc_vat', 'portions', 'ingredients'];
    const rows = (await costDishes(db)).map(({ dish, lines, result }) => ({
      name: dish.name, type: dish.type, active: dish.active ? 'yes' : 'no',
      menu_price_inc_vat: money(result.menuInc), price_ex_vat: money(result.priceEx), true_cost: money(result.trueCost),
      gp: money(result.gpMoney), gp_pct: pct(result.gpPct), target_gp: pct(result.rates.targetGp),
      status: result.status.label, suggested_price_inc_vat: money(result.suggested.incVat), portions: dish.yield_portions,
      ingredients: lines.map((l) => `${l.ingredient.name} ${formatQty(l.quantity)} ${l.unit}`).join('; '),
    }));
    sendCsv(res, `dishes-${stamp()}.csv`, toCsv(columns, rows));
  });

  // Full backup of everything except the password, as JSON (restore with scripts/restore.js).
  router.get('/export/backup', async (req, res) => {
    sendJson(res, `gp-costing-backup-${stamp()}.json`, JSON.stringify(await createSnapshot(db), null, 1));
  });

  router.get('/export/backups/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    const backup = id && await getBackup(db, id);
    if (!backup) return next();
    sendJson(res, `gp-costing-backup-${backup.created_at.slice(0, 10)}-nightly.json`, backup.data);
  });

  return router;
}

function sendJson(res, filename, body) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}
