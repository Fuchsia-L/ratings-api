import { buildApp, openDatabase } from './app.js';

const SYNC_TOKEN = process.env.SYNC_TOKEN;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
const READONLY_TOKEN = process.env.READONLY_TOKEN;
const WRITE_TOKEN = process.env.WRITE_TOKEN;
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/ratings.db';

if (!SYNC_TOKEN || SYNC_TOKEN.length < 32) {
  console.error('FATAL: SYNC_TOKEN missing or too short (need >= 32 chars)');
  process.exit(1);
}

// READONLY_TOKEN 是可选的：缺失/过短只是关掉只读查询这条路，不 fatal。
if (READONLY_TOKEN && READONLY_TOKEN.length < 32) {
  console.error('WARN: READONLY_TOKEN too short (need >= 32 chars) — readonly query access disabled');
}
const readonlyToken = READONLY_TOKEN && READONLY_TOKEN.length >= 32 ? READONLY_TOKEN : undefined;

// WRITE_TOKEN 同样可选：缺失/过短只关掉写端点（v3 增删改），服务照常起。
if (WRITE_TOKEN && WRITE_TOKEN.length < 32) {
  console.error('WARN: WRITE_TOKEN too short (need >= 32 chars) — write endpoints disabled');
}
const writeToken = WRITE_TOKEN && WRITE_TOKEN.length >= 32 ? WRITE_TOKEN : undefined;

const db = openDatabase(DB_PATH);

const fastify = buildApp({
  db,
  syncToken: SYNC_TOKEN,
  readonlyToken,
  writeToken,
  internalToken: INTERNAL_TOKEN,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

fastify.listen({ host: '127.0.0.1', port: PORT }).then((addr) => {
  fastify.log.info(`ratings-api listening on ${addr}`);
  if (!readonlyToken) fastify.log.info('READONLY_TOKEN not configured — query endpoints require SYNC_TOKEN');
  if (!writeToken) fastify.log.info('WRITE_TOKEN not configured — write endpoints require SYNC_TOKEN');
}).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});

const shutdown = async (sig) => {
  fastify.log.info(`${sig} received, shutting down`);
  await fastify.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
