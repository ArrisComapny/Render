import Fastify from 'fastify';
import { Stagehand } from '@browserbasehq/stagehand';
import Steel from 'steel-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const fastify = Fastify({ logger: true });
const SESSIONS = new Map(); // session_id -> { stagehand, steelSession, createdAt }

const steel = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

fastify.addHook('onRequest', async (req, reply) => {
  const expected = `Bearer ${process.env.WRAPPER_API_TOKEN}`;
  if (req.headers.authorization !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

// чистка старых сессий каждые 5 минут
setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (now - s.createdAt > 13 * 60 * 1000) {
      try { await s.stagehand.close(); } catch {}
      try { await steel.sessions.release(s.steelSession.id); } catch {}
      SESSIONS.delete(id);
    }
  }
}, 5 * 60 * 1000);

// --- 1. Создать сессию ---
fastify.post('/session/create', async (req) => {
  const { url, reuse_steel_session_id } = req.body;

  fastify.log.info('VERSION: hobby-clean-v3');

  let steelSession;
  if (reuse_steel_session_id) {
    steelSession = await steel.sessions.retrieve(reuse_steel_session_id);
  } else {
    // Минимальная конфигурация под hobby-план: без платных useProxy / solveCaptcha
    steelSession = await steel.sessions.create({
      timeout: 840000, // 14 минут (лимит hobby-плана — 15 мин)
    });
  }

  // Подключаем Stagehand к Steel по CDP
  const stagehand = new Stagehand({
    env: 'LOCAL',
    localBrowserLaunchOptions: {
      cdpUrl: `${steelSession.websocketUrl}&apiKey=${process.env.STEEL_API_KEY}`,
    },
    enableCaching: false,
    modelName: 'anthropic/claude-sonnet-4-6',
    modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY },
  });

  await stagehand.init();
  if (url) await stagehand.page.goto(url, { waitUntil: 'domcontentloaded' });

  const sessionId = randomUUID();
  SESSIONS.set(sessionId, { stagehand, steelSession, createdAt: Date.now() });

  return {
    session_id: sessionId,
    steel_session_id: steelSession.id,
    live_view_url: steelSession.sessionViewerUrl,
    current_url: stagehand.page.url(),
  };
});

// --- 2. act ---
fastify.post('/session/act', async (req) => {
  const { session_id, instruction } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };
  try {
    const result = await s.stagehand.page.act(instruction);
    return { status: 'ok', current_url: s.stagehand.page.url(), result };
  } catch (err) {
    return { status: 'error', message: err.message, current_url: s.stagehand.page.url() };
  }
});

// --- 3. extract ---
fastify.post('/session/extract', async (req) => {
  const { session_id, instruction, schema } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };
  const zodSchema = buildZodFromJson(schema);
  try {
    const data = await s.stagehand.page.extract({ instruction, schema: zodSchema });
    return { status: 'ok', data };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
});

// --- 4. observe ---
fastify.post('/session/observe', async (req) => {
  const { session_id, instruction } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };
  const observations = await s.stagehand.page.observe(instruction || undefined);
  return { status: 'ok', observations, current_url: s.stagehand.page.url() };
});

// --- 5. close ---
fastify.post('/session/close', async (req) => {
  const { session_id } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };
  try { await s.stagehand.close(); } catch {}
  try { await steel.sessions.release(s.steelSession.id); } catch {}
  SESSIONS.delete(session_id);
  return { status: 'closed' };
});

// healthcheck без авторизации мешает hook'у — оставляем всё под токеном

function buildZodFromJson(schemaJson) {
  const shape = {};
  if (Array.isArray(schemaJson?.fields)) {
    for (const f of schemaJson.fields) {
      let t;
      switch (f.type) {
        case 'number': t = z.number(); break;
        case 'boolean': t = z.boolean(); break;
        case 'array': t = z.array(z.string()); break;
        default: t = z.string();
      }
      shape[f.name] = f.optional ? t.optional() : t;
    }
  }
  if (schemaJson?.isList) {
    return z.object({ items: z.array(z.object(shape)) });
  }
  return z.object(shape);
}

const port = process.env.PORT || 3000;
fastify.listen({ port, host: '0.0.0.0' });