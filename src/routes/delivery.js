import { Router } from 'express';
import { listChannels } from '../db/index.js';
import { costDishes } from '../costing.js';
import { parseId } from '../input.js';

export default function deliveryRoutes({ db }) {
  const router = Router();

  router.get('/delivery', async (req, res) => {
    const channels = await listChannels(db);
    const wanted = parseId(req.query.channel);
    const channel = channels.find((c) => c.id === wanted) || channels[0] || null;
    const rows = channel
      ? (await costDishes(db)).filter((r) => r.dish.active).map((r) => ({
        ...r, delivery: r.result.delivery.find((d) => d.channelId === channel.id),
      }))
      : [];
    res.render('delivery', { title: 'Delivery prices', channels, channel, rows });
  });

  return router;
}
