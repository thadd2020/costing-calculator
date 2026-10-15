import { Router } from 'express';
import multer from 'multer';
import { getImportBatch, listIngredients, finishImportBatch } from '../db/index.js';
import { previewImport, commitImport, ImportError } from '../import/service.js';
import { planImport } from '../import/plan.js';
import { TEMPLATE_COLUMNS, MAX_BYTES } from '../import/parse.js';
import { toCsv, sendCsv } from '../csv.js';
import { verifyCsrf, flash } from '../security.js';
import { parseId } from '../input.js';

// Memory storage only: uploads are never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 },
  fileFilter: (req, file, cb) => {
    const looksCsv = /\.csv$/i.test(file.originalname)
      || ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'].includes(file.mimetype);
    cb(null, looksCsv);
  },
});

export default function importRoutes({ db }) {
  const router = Router();

  router.get('/import', (req, res) => {
    res.render('import/upload', { title: 'Import ingredients', error: null });
  });

  router.get('/import/template.csv', (req, res) => {
    sendCsv(res, 'ingredients-template.csv', toCsv(TEMPLATE_COLUMNS, [{
      name: 'Plain flour', supplier: 'Brakes', category: 'Dry goods', pack_size: 16, pack_unit: 'kg',
      pack_price: '12.00', price_includes_vat: 'no', vat_rate: '0%', waste_pct: '2%',
    }]));
  });

  router.post('/import/preview', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 2 MB. Split it into smaller files.' : 'The upload failed. Choose a single CSV file and try again.';
        return res.status(400).render('import/upload', { title: 'Import ingredients', error: message });
      }
      verifyCsrf(req, res, next);
    });
  }, async (req, res) => {
    if (!req.file) {
      return res.status(400).render('import/upload', { title: 'Import ingredients', error: 'Choose a CSV file. Save spreadsheets as "CSV UTF-8" first.' });
    }
    const filename = String(req.file.originalname).slice(0, 200);
    const result = await previewImport(db, { filename, buffer: req.file.buffer });
    if (result.fatal) return res.status(400).render('import/upload', { title: 'Import ingredients', error: result.fatal });
    res.redirect(`/import/${result.batchId}`);
  });

  router.get('/import/:batchId', async (req, res, next) => {
    const batch = await loadBatch(req);
    if (!batch) return next();
    if (batch.status === 'committed') {
      return res.render('import/result', { title: 'Import complete', batch, summary: batch.summary });
    }
    if (batch.status === 'discarded') {
      return res.render('error', { title: 'Import cancelled', message: 'This import was cancelled or expired. Upload the file again to start over.' });
    }
    // Plan against current ingredients, so the preview reflects any edits since upload.
    const plan = planImport(batch.payload.rows, await listIngredients(db), batch.payload.errors.length);
    const changes = plan.items.filter((i) => i.action !== 'unchanged');
    res.render('import/preview', { title: 'Check the import', batch, plan, changes, errors: batch.payload.errors });
  });

  router.post('/import/:batchId/commit', async (req, res, next) => {
    const id = parseId(req.params.batchId);
    if (!id) return next();
    try {
      const outcome = await commitImport(db, id);
      if (outcome.error === 'not_found') return next();
      if (outcome.error) {
        flash(req, outcome.error === 'committed' ? 'This import was already confirmed.' : 'This import was cancelled. Upload the file again.', 'error');
      } else {
        const c = outcome.result;
        flash(req, `Imported: ${c.new} new, ${c.price_changed} price changes, ${c.details_changed} other updates.`);
      }
    } catch (err) {
      if (!(err instanceof ImportError)) throw err;
      flash(req, `Nothing was imported. ${err.message}`, 'error');
    }
    res.redirect(`/import/${id}`);
  });

  router.post('/import/:batchId/discard', async (req, res, next) => {
    const id = parseId(req.params.batchId);
    if (!id) return next();
    const discarded = await finishImportBatch(db, id, 'discarded', {});
    if (discarded) flash(req, 'Import cancelled. Nothing was changed.');
    else flash(req, 'This import had already been confirmed or cancelled, so there was nothing to cancel.', 'error');
    res.redirect('/import');
  });

  router.get('/import/:batchId/errors.csv', async (req, res, next) => {
    const batch = await loadBatch(req);
    if (!batch || !batch.payload.errors) return next();
    const rows = batch.payload.errors.map((e) => ({ row: e.row, problem: e.message, ...e.raw }));
    sendCsv(res, `rejected-rows-${batch.id}.csv`, toCsv(['row', 'problem', ...TEMPLATE_COLUMNS], rows));
  });

  async function loadBatch(req) {
    const id = parseId(req.params.batchId);
    return id ? getImportBatch(db, id) : null;
  }

  return router;
}
