import Fastify from 'fastify';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const fastify = Fastify({ logger: true });
const SESSIONS = new Map(); // session_id -> { stagehand, createdAt }

// Простая bearer-аутентификация
fastify.addHook('onRequest', async (req, reply) => {
  const expected = `Bearer ${process.env.WRAPPER_API_TOKEN}`;
  if (req.headers.authorization !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

// Чистим сессии старше 1 часа, чтобы Browserbase не копил счёт
setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (now - s.createdAt > 60 * 60 * 1000) {
      try { await s.stagehand.close(); } catch {}
      SESSIONS.delete(id);
    }
  }
}, 5 * 60 * 1000);

// --- 1. Создать сессию ---
fastify.post('/session/create', async (req) => {
  const { url, browserbase_session_id } = req.body;
  // browserbase_session_id опционален — если передан, переиспользуем существующую сессию (cookies сохранены)

  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    modelName: 'claude-sonnet-4-5-20250929', // или 'gpt-4o' если предпочитаете OpenAI
    modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY },
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      browserSettings: {
        // выбор ОС задаёт fingerprint
        // верифицированный профиль = проходит через Cloudflare/Stytch
        viewport: { width: 1366, height: 768 },
      },
      proxies: true,         // встроенные резидентные прокси
      keepAlive: true,        // сессия живёт после закрытия Stagehand → можно вернуться
    },
    browserbaseSessionID: browserbase_session_id, // если передан — реюзаем
  });

  await stagehand.init();
  if (url) await stagehand.page.goto(url, { waitUntil: 'domcontentloaded' });

  const sessionId = randomUUID();
  SESSIONS.set(sessionId, { stagehand, createdAt: Date.now() });

  return {
    session_id: sessionId,
    browserbase_session_id: stagehand.browserbaseSessionID,
    live_view_url: `https://www.browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
    current_url: stagehand.page.url(),
  };
});

// --- 2. Выполнить действие ---
fastify.post('/session/act', async (req) => {
  const { session_id, instruction } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };

  try {
    const result = await s.stagehand.page.act(instruction);
    return {
      status: 'ok',
      current_url: s.stagehand.page.url(),
      result,
    };
  } catch (err) {
    return { status: 'error', message: err.message, current_url: s.stagehand.page.url() };
  }
});

// --- 3. Извлечь данные ---
fastify.post('/session/extract', async (req) => {
  const { session_id, instruction, schema } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };

  // schema приходит как JSON-описание; преобразуем в Zod
  // для простоты поддержим только базовые поля
  const zodSchema = buildZodFromJson(schema);

  try {
    const data = await s.stagehand.page.extract({ instruction, schema: zodSchema });
    return { status: 'ok', data };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
});

// --- 4. Наблюдать (что доступно на странице) ---
fastify.post('/session/observe', async (req) => {
  const { session_id, instruction } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };

  const observations = await s.stagehand.page.observe(instruction || undefined);
  return { status: 'ok', observations, current_url: s.stagehand.page.url() };
});

// --- 5. Закрыть ---
fastify.post('/session/close', async (req) => {
  const { session_id } = req.body;
  const s = SESSIONS.get(session_id);
  if (!s) return { error: 'session_not_found' };

  await s.stagehand.close();
  SESSIONS.delete(session_id);
  return { status: 'closed' };
});

// Хелпер: простой JSON → Zod
function buildZodFromJson(schemaJson) {
  // schemaJson вид: { fields: [{ name: "title", type: "string" }, ...] }
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