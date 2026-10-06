import express from 'express';

const TUNE_KEYS = new Set(['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']);
const TUNE_SCALES = new Set(['minor','major']);

function boolHeader(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1','true','yes','on'].includes(String(value).trim().toLowerCase());
}

function processingHeaders(req) {
  const clean = boolHeader(req.headers['x-studio-clean'], true);
  const tune = boolHeader(req.headers['x-studio-tune'], false);
  const key = String(req.headers['x-studio-key'] || 'F').trim().toUpperCase();
  const scale = String(req.headers['x-studio-scale'] || 'minor').trim().toLowerCase();
  const amount = Number(req.headers['x-studio-amount'] ?? 70);
  const speed = Number(req.headers['x-studio-speed'] ?? 35);

  if (!clean && !tune) {
    const error = new Error('Не выбрана AI-обработка вокала.');
    error.status = 400;
    throw error;
  }
  if (tune && (!TUNE_KEYS.has(key) || !TUNE_SCALES.has(scale))) {
    const error = new Error('Некорректная тональность AutoTune.');
    error.status = 400;
    throw error;
  }
  if (tune && (![amount, speed].every(Number.isInteger) || amount < 0 || amount > 100 || speed < 0 || speed > 100)) {
    const error = new Error('Некорректные настройки AutoTune.');
    error.status = 400;
    throw error;
  }

  return {
    clean,
    tune,
    key,
    scale,
    amount,
    speed,
    headers: {
      'X-Studio-Clean': clean ? '1' : '0',
      'X-Studio-Tune': tune ? '1' : '0',
      'X-Studio-Key': key,
      'X-Studio-Scale': scale,
      'X-Studio-Amount': String(amount),
      'X-Studio-Speed': String(speed)
    }
  };
}

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
    if (!configured) return res.json({ aiAvailable: false, tuneAvailable: false });
    try {
      const response = await fetch(`${workerUrl}/health`, {
        headers: { Authorization: `Bearer ${workerToken}` },
        signal: AbortSignal.timeout(5000)
      });
      const state = response.ok ? await response.json() : {};
      return res.json({
        aiAvailable: state.ready === true,
        tuneAvailable: state.ready === true && state.tuneAvailable === true
      });
    } catch {
      return res.json({ aiAvailable: false, tuneAvailable: false });
    }
  });

  app.post('/api/studio/enhance', requireTelegramUser,
    (req, res, next) => {
      if (!configured) return res.status(503).json({ error: 'Vocal AI пока не подключён.' });
      if (active >= 2 || inFlight.has(req.telegramUser.id)) {
        return res.status(429).json({ error: 'Студия занята. Повторите через минуту.' });
      }
      active++;
      inFlight.add(req.telegramUser.id);
      let released = false;
      req.releaseStudio = () => {
        if (!released) {
          released = true;
          active--;
          inFlight.delete(req.telegramUser.id);
        }
      };
      res.once('finish', req.releaseStudio);
      next();
    },
    express.raw({ type: 'application/octet-stream', limit: '20mb' }),
    async (req, res) => {
      let chargedDay;
      try {
        if (
          !Buffer.isBuffer(req.body) ||
          req.body.length < 44 ||
          req.body.toString('ascii', 0, 4) !== 'RIFF' ||
          req.body.toString('ascii', 8, 12) !== 'WAVE'
        ) {
          return res.status(400).json({ error: 'Нужен вокал в формате WAV.' });
        }

        const processing = processingHeaders(req);
        await init();

        const quota = await pool.query(`INSERT INTO studio_ai_usage (telegram_id, requests) VALUES ($1,1)
          ON CONFLICT (telegram_id,usage_day) DO UPDATE SET requests=studio_ai_usage.requests+1
          WHERE studio_ai_usage.requests < 3 RETURNING usage_day::text`, [req.telegramUser.id]);

        if (!quota.rowCount) {
          return res.status(429).json({
            error: 'На сегодня доступны 3 AI-обработки вокала. Локальные эффекты работают без этого лимита.'
          });
        }
        chargedDay = quota.rows[0].usage_day;

        const response = await fetch(`${workerUrl}/enhance`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${workerToken}`,
            'Content-Type': 'application/octet-stream',
            ...processing.headers
          },
          body: req.body,
          signal: AbortSignal.timeout(240000)
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`worker status ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
        }

        const output = Buffer.from(await response.arrayBuffer());
        if (
          output.length > 20 * 1024 * 1024 ||
          output.length < 44 ||
          output.toString('ascii', 0, 4) !== 'RIFF' ||
          output.toString('ascii', 8, 12) !== 'WAVE'
        ) {
          throw new Error('Invalid worker output');
        }

        res.set({
          'Content-Type': 'audio/wav',
          'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment; filename="processed-vocal.wav"'
        });
        res.send(output);
      } catch (error) {
        if (chargedDay) {
          await pool.query(
            'UPDATE studio_ai_usage SET requests=GREATEST(0,requests-1) WHERE telegram_id=$1 AND usage_day=$2',
            [req.telegramUser.id, chargedDay]
          ).catch(() => {});
        }
        console.error('Studio processing failed:', error.message);
        const status = Number(error.status) || 502;
        if (!res.headersSent) {
          res.status(status).json({
            error: status < 500 ? error.message : 'Не удалось обработать вокал. Повторите позже или выключите AI CLEAN / TUNE.'
          });
        }
      } finally {
        req.releaseStudio();
      }
    },
    (error, req, res, _next) => {
      req.releaseStudio?.();
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({
        error: 'Не удалось принять аудио. Максимум 20 МБ WAV.'
      });
    }
  );
}
