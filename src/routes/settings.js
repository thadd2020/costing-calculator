import { Router } from 'express';
import {
  getSettings, setSettings, listChannels, getChannel, createChannel, updateChannel, deleteChannel, setStoredPasswordHash,
} from '../db/index.js';
import { ROUNDING_STEPS } from '../calc/calc.js';
import { parseMoney, parsePercentField, cleanText, parseId } from '../input.js';
import { checkPassword, hashPassword, PASSWORD_MIN } from '../auth.js';
import { flash } from '../security.js';

export default function settingsRoutes({ db, config }) {
  const router = Router();

  const render = async (res, extra = {}) => res.render('settings', {
    title: 'Settings',
    settings: await getSettings(db),
    channels: await listChannels(db),
    roundingSteps: ROUNDING_STEPS,
    errors: [], passwordError: null, channelError: null, values: null,
    ...extra,
  });

  router.get('/settings', (req, res) => render(res));

  router.post('/settings', async (req, res) => {
    const errors = [];
    const pctField = (field, label, min, max) => {
      const v = parsePercentField(req.body[field]);
      if (v === null || v < min || v > max) errors.push(`${label} must be a percentage from ${min * 100} to ${max * 100}.`);
      return v;
    };
    const values = {
      vat_rate: pctField('vat_rate', 'VAT rate', 0, 0.5),
      target_gp_food: pctField('target_gp_food', 'Food target GP', 0, 0.95),
      target_gp_drink: pctField('target_gp_drink', 'Drink target GP', 0, 0.95),
      alert_gp: pctField('alert_gp', 'Alert threshold', 0, 0.95),
      default_packaging: parseMoney(req.body.default_packaging),
      round_up_to_pence: Number(req.body.round_up_to_pence),
    };
    if (values.default_packaging === null || values.default_packaging < 0) errors.push('Default packaging must be an amount like 0.50.');
    if (!ROUNDING_STEPS.includes(values.round_up_to_pence)) errors.push('Choose a rounding option.');
    if (!errors.length && (values.alert_gp > values.target_gp_food || values.alert_gp > values.target_gp_drink)) {
      errors.push('The alert threshold should be at or below both target GPs.');
    }
    if (errors.length) return res.status(422).render('settings', {
      title: 'Settings', settings: await getSettings(db), channels: await listChannels(db), roundingSteps: ROUNDING_STEPS,
      errors, passwordError: null, channelError: null, values: req.body,
    });
    await setSettings(db, values);
    flash(req, 'Settings saved. Every dish has been recalculated.');
    res.redirect('/settings');
  });

  const parseChannel = (body) => {
    const name = cleanText(body.name, 100);
    const commission = parsePercentField(body.commission);
    if (!name) return { error: 'Give the channel a name.' };
    if (commission === null || commission < 0 || commission >= 1) return { error: 'Commission must be a percentage from 0 to 99.' };
    return { data: { name, commission } };
  };

  router.post('/settings/channels', async (req, res) => {
    const { data, error } = parseChannel(req.body);
    const result = error ? { error } : await createChannel(db, data);
    if (result.error) {
      return render(res.status(422), { channelError: result.error === 'duplicate' ? `There's already a channel called ${data.name}.` : result.error });
    }
    flash(req, `Added ${data.name}.`);
    res.redirect('/settings#channels');
  });

  router.post('/settings/channels/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id || !(await getChannel(db, id))) return next();
    const { data, error } = parseChannel(req.body);
    const result = error ? { error } : await updateChannel(db, id, data);
    if (result.error) {
      return render(res.status(422), { channelError: result.error === 'duplicate' ? `There's already a channel called ${data.name}.` : result.error });
    }
    flash(req, `Saved ${data.name}.`);
    res.redirect('/settings#channels');
  });

  router.post('/settings/channels/:id/delete', async (req, res, next) => {
    const id = parseId(req.params.id);
    const channel = id && await getChannel(db, id);
    if (!channel) return next();
    await deleteChannel(db, id);
    flash(req, `Removed ${channel.name}.`);
    res.redirect('/settings#channels');
  });

  router.post('/settings/password', async (req, res) => {
    const { current_password: current, new_password: next1, confirm_password: next2 } = req.body;
    let error = null;
    if (!(await checkPassword(db, config, current))) error = "Your current password isn't right.";
    else if (typeof next1 !== 'string' || next1.length < PASSWORD_MIN) error = `Choose a new password of at least ${PASSWORD_MIN} characters.`;
    else if (next1.length > 200) error = 'That password is too long (200 characters at most).';
    else if (next1 !== next2) error = "The two new passwords don't match.";
    if (error) return render(res.status(422), { passwordError: error });
    await setStoredPasswordHash(db, await hashPassword(next1));
    flash(req, 'Password changed. Use the new one next time you log in.');
    res.redirect('/settings#password');
  });

  return router;
}
