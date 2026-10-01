import express from 'express';

// Limit abuse in PostgreSQL as well as local concurrency; quotas survive restarts.
export function mountStudioRoutes(app, { pool, requireTelegramUser }) {
  const workerUrl = String(process.env.STUDIO_AI_URL || '').replace(/\/$/, '');
  const workerToken = process.env.STUDIO_AI_TOKEN || '';
  const configured = Boolean(workerUrl && workerToken);
  let active = 0;
  const inFlight = new Set();
  let schema;
  const init = () => schema ||= pool.query(`CREATE TABLE IF NOT EXISTS studio_ai_usage (
    telegram_id BIGINT NOT NULL,
    usage_day DATE NOT NULL DEFAULT CURRENT_DATE,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (telegram_id, usage_day)
  )`).catch(error => { schema = null; throw error; });
  app.get('/api/studio/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!configured) return res.json({ aiAvailable: false });
    try {
      const response = await fetch(`${workerUrl}/health`, { headers: { Authorization: `Bearer ${workerToken}` }, signal: AbortSignal.timeout(3000) });
      const state = response.ok ? await response.json() : {};
      return res.json({ aiAvailable: state.ready === true });
    } catch { return res.json({ aiAvailable: false }); }
  });
  app.post('/api/studio/enhance', requireTelegramUser,
    (req, res, next) => {
      if (!configured) return res.status(503).json({ error: 'ИИ-очистка пока не подключена.' });
      if (active >= 2 || inFlight.has(req.telegramUser.id)) return res.status(429).json({ error: 'Студия занята. Повторите через минуту.' });
      active++; inFlight.add(req.telegramUser.id);
      let released = false;
      req.releaseStudio = () => { if (!released) { released = true; active--; inFlight.delete(req.telegramUser.id); } };
      // Do not release processing slots on disconnect while upstream inference is running.
      res.once('finish', req.releaseStudio);
      next();
    }, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
      let chargedDay;
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString('ascii', 0, 4) !== 'RIFF' || req.body.toString('ascii', 8, 12) !== 'WAVE') {
          return res.status(400).json({ error: 'Нужен вокал в формате WAV.' });
        }
        await init();
        const quota = await pool.query(`INSERT INTO studio_ai_usage (telegram_id, requests) VALUES ($1,1)
          ON CONFLICT (telegram_id,usage_day) DO UPDATE SET requests=studio_ai_usage.requests+1
          WHERE studio_ai_usage.requests < 3 RETURNING usage_day::text`, [req.telegramUser.id]);
        if (!quota.rowCount) return res.status(429).json({ error: 'На сегодня доступны 3 ИИ-обработки. Эффекты без ИИ работают без этого лимита.' });
        chargedDay = quota.rows[0].usage_day;
        const response = await fetch(`${workerUrl}/enhance`, {
          method: 'POST', headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/octet-stream' },
          body: req.body, signal: AbortSignal.timeout(165000)
        });
        if (!response.ok) throw new Error(`worker status ${response.status}`);
        // The trusted worker emits at most 180 seconds of mono 48 kHz PCM16.
        const output = Buffer.from(await response.arrayBuffer());
        if (output.length > 20 * 1024 * 1024 || output.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Invalid worker output');
        res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="clean-vocal.wav"' });
        res.send(output);
      } catch (error) {
        if (chargedDay) await pool.query('UPDATE studio_ai_usage SET requests=GREATEST(0,requests-1) WHERE telegram_id=$1 AND usage_day=$2', [req.telegramUser.id, chargedDay]).catch(() => {});
        console.error('Studio processing failed:', error.message);
        if (!res.headersSent) res.status(502).json({ error: 'Не удалось очистить вокал. Повторите позже или выключите ИИ-очистку.' });
      } finally { req.releaseStudio(); }
    }, (error, req, res, _next) => {
      req.releaseStudio?.();
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Не удалось принять аудио. Максимум 20 МБ WAV.' });
    });
}
