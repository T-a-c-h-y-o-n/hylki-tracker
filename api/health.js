// A tiny health check: is the deployment alive, and can it reach its store?
//
// GET /api/health

import { redis } from '../lib/redis.js';

export default async function handler(req, res) {
  const report = { ok: true, redis: 'unknown' };
  try {
    const pong = await redis('PING');
    report.redis = pong === 'PONG' ? 'ok' : String(pong);
  } catch (error) {
    report.ok = false;
    report.redis = 'error';
    report.detail = String(error.message || error);
  }
  res.status(200).json(report);
}
