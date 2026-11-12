import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { lastBackup, backupDatabase } from './maintenance.mjs';
import { makeSessions, matchesPassword, normalizeEmail } from './security.mjs';
import { registerAdministration, provisionAdministrator } from './administration.mjs';
import { registerWorkflow } from './workflow.mjs';
import { registerOutcomes, sendDueEvaluations } from './outcomes.mjs';
import { registerIntegrations, institutionalAvailable, queueEmail } from './integrations.mjs';
import { seedDemo } from './seed.mjs';
import { overview } from './overview.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const startedAt = new Date().toISOString();
const now = () => new Date().toISOString();
const fail = (status, message) => { throw Object.assign(new Error(message), { status, safe: true }); };
const log = (level, message, properties = {}) => console[level](JSON.stringify({ at: now(), level, message, ...properties }));

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  if (!req.headers['content-type'] && !(Number(req.headers['content-length']) > 0) && !req.headers['transfer-encoding']) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail(415, 'Envie o corpo da requisição em JSON.');
  const limit = 24 * 1024 * 1024;
  if (Number(req.headers['content-length']) > limit) fail(413, 'O conteúdo excede o limite de 24 MB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      fail(413, 'O conteúdo excede o limite de 24 MB.');
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'O corpo da requisição contém JSON inválido.'); }
  if (!data || typeof data !== 'object') fail(400, 'O corpo da requisição deve ser um objeto ou lista.');
  return data;
}

function serveStatic(pathname, req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const path = pathname === '/' ? '/index.html' : pathname;
  const relative = decodeURIComponent(path).slice(1);
  const filename = resolve(root, relative);
  if (!filename.startsWith(resolve(root) + sep) || !mime[extname(filename)]) return false;
  let size;
  try {
    const file = statSync(filename);
    if (!file.isFile()) return false;
    size = file.size;
  } catch { return false; }
  res.writeHead(200, { 'Content-Type': mime[extname(filename)], 'Content-Length': size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(filename).pipe(res);
  return true;
}

function headers(res, config, requestId) {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function makeRateLimiter() {
  const attempts = new Map();
  return (key, max, interval) => {
    const time = Date.now();
    if (attempts.size > 10000) {
      for (const [id, item] of attempts) if (item.until < time) attempts.delete(id);
      if (attempts.size > 10000) fail(429, 'Limite de tentativas. Aguarde alguns minutos.');
    }
    const previous = attempts.get(key);
    const entry = previous && previous.until > time ? previous : { count: 0, until: time + interval };
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > max) fail(429, 'Limite de tentativas. Aguarde alguns minutos.');
  };
}

export function createApplication(overrides = {}) {
  const config = readConfig(overrides);
  const db = openStore(config.database);
  const sessions = makeSessions(db, config);
  const routes = [];
  const timers = [];
  const rateLimit = makeRateLimiter();
  if (config.demo) seedDemo(db);
  else provisionAdministrator(db);
  const route = (method, pattern, permission, handler, description = '') => {
    const names = [];
    const match = new RegExp('^' + pattern.split('/').map(part => {
      if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/') + '$');
    routes.push({ method, pattern, permission, handler, names, match, description });
  };
  const auditFor = (actor) => (action, entity, entityId, details = {}) => db.save('audit', {
    action, entity, entityId, details, actorId: actor?.id ?? null, actorName: actor?.name ?? 'Sistema',
    org: actor?.scopeOrg || actor?.org || '', unit: actor?.scopeUnit || actor?.unit || '', at: now()
  });
  const notify = (userId, subject, text, link) => {
    if (!userId) return;
    const account = db.get('users', userId);
    if (!account || account.active === false) return;
    return db.tx(() => {
      const item = db.save('notifications', { userId, subject, text, link, createdAt: now(), readAt: null });
      if (!config.demo && account.email) queueEmail(db, { ...item, to: account.email });
      return item;
    });
  };
  const app = { route, db, env: config.env, demo: config.demo, baseUrl: config.baseUrl,
    secureCookies: config.secureCookies, config, sessions, log, audit: auditFor(null), notify,
    onClose(fn) { timers.push(fn); } };

  route('GET', '/health', '*', () => ({ status: db.ping() ? 'ok' : 'unavailable' }), 'Sonda de disponibilidade');
  route('GET', '/api/auth/config', '*', () => ({
    demo: config.demo, password: config.allowPassword, institutional: institutionalAvailable(app), environment: config.env
  }), 'Métodos de autenticação disponíveis');
  route('GET', '/api/me', null, ({ user }) => user, 'Conta autenticada e permissões efetivas');
  route('GET', '/api/overview', null, overview, 'Resumo dos registros no escopo do perfil autenticado');
  route('POST', '/api/auth/login', '*', ({ body, req, login }) => {
    if (!config.allowPassword) fail(403, 'Use a autenticação institucional.');
    rateLimit('auth:' + req.socket.remoteAddress, 25, 10 * 60_000);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || email.length > 254 || !password || password.length > 256) fail(400, 'Informe o e-mail e a senha.');
    const account = db.list('users').find(item => normalizeEmail(item.email) === email && item.active !== false);
    if (!matchesPassword(password, account?.passwordHash)) fail(401, 'E-mail ou senha inválidos.');
    return login(account.id);
  }, 'Inicia sessão de teste ou de administração local autorizada');
  route('POST', '/api/auth/logout', null, ({ req, res, user, audit }) => {
    sessions.end(req, res);
    audit('logout', 'users', user.id);
    return { ok: true };
  }, 'Encerra e revoga a sessão atual');
  route('GET', '/api/notifications', null, ({ user }) => db.list('notifications')
    .filter(item => item.userId === user.id).reverse().slice(0, 100), 'Notificações do usuário');
  route('POST', '/api/notifications/read', null, ({ user }) => {
    db.tx(() => {
      for (const item of db.list('notifications')) {
        if (item.userId === user.id && !item.readAt) db.save('notifications', { ...item, readAt: now() });
      }
    });
    return { ok: true };
  }, 'Marca notificações próprias como lidas');

  registerAdministration(app);
  registerWorkflow(app);
  registerOutcomes(app);
  registerIntegrations(app);

  route('GET', '/api/openapi.json', null, ({ user }) => {
    const paths = {};
    for (const item of routes) {
      if (item.permission !== '*' && item.permission !== null && !user.permissions.includes(item.permission)) continue;
      const key = item.pattern.replace(/:([\w]+)/g, '{$1}');
      const operation = {
        summary: item.description || item.pattern,
        security: item.permission === '*' ? [] : [{ session: [] }],
        parameters: item.names.map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
        responses: { 200: { description: 'Operação concluída' }, 400: { description: 'Requisição inválida' },
          401: { description: 'Autenticação necessária' }, 403: { description: 'Acesso negado' },
          404: { description: 'Recurso não localizado' }, 409: { description: 'Conflito com o estado do registro' } }
      };
      if (['POST', 'PATCH', 'PUT'].includes(item.method)) operation.requestBody = {
        content: { 'application/json': { schema: { type: 'object' } } }
      };
      (paths[key] ??= {})[item.method.toLowerCase()] = operation;
    }
    return { openapi: '3.1.0', info: { title: 'API Gestão de Capacitações', version: '1.0.0' }, servers: [{ url: config.baseUrl }],
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: config.secureCookies ? '__Host-cap_session' : 'cap_session' } } }, paths };
  }, 'Inventário OpenAPI de rotas disponíveis ao perfil');

  const handler = async (req, res) => {
    const requestId = randomUUID();
    headers(res, config, requestId);
    let matched;
    try {
      const url = new URL(req.url, config.baseUrl);
      if (url.origin !== config.baseUrl || req.headers.host !== new URL(config.baseUrl).host &&
          !(config.env === 'production' && process.env.CAP_TLS_PROXY === '1' && req.headers.host === config.host + ':' + config.port)) {
        fail(421, 'Use o endereço configurado para este sistema.');
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== config.baseUrl) fail(403, 'Origem da requisição inválida.');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Origem da requisição inválida.');
      }
      let match;
      for (const candidate of routes) {
        if (req.method !== candidate.method) continue;
        match = candidate.match.exec(url.pathname);
        if (match) { matched = candidate; break; }
      }
      if (!matched) {
        if (serveStatic(url.pathname, req, res)) return;
        fail(404, 'Página ou operação não encontrada.');
      }
      if (matched.permission === '*' && (url.pathname.startsWith('/api/validation') || url.pathname === '/validar' && url.searchParams.has('codigo'))) {
        rateLimit('validation:' + req.socket.remoteAddress, 100, 60_000);
      }
      if (matched.permission === '*' && url.pathname.startsWith('/api/auth/institutional')) {
        rateLimit('institutional:' + req.socket.remoteAddress, 30, 60_000);
      }
      const user = sessions.current(req);
      if (matched.permission !== '*' && !user) fail(401, 'Entre para continuar.');
      const check = (permission) => Boolean(user?.permissions.includes(permission));
      if (typeof matched.permission === 'string' && matched.permission !== '*' && !check(matched.permission)) fail(403, 'Seu perfil não tem acesso a esta operação.');
      const login = (userId) => {
        const account = db.get('users', userId);
        if (!account || account.active === false) fail(403, 'A conta está indisponível.');
        const active = sessions.create(req, res, account);
        auditFor(active)('login', 'users', active.id);
        return active;
      };
      const ctx = { user, body: await readBody(req), params: Object.fromEntries(matched.names.map((name, i) => [name, decodeURIComponent(match[i + 1])])),
        query: Object.fromEntries(url.searchParams), req, res, db, fail, check, audit: auditFor(user), notify, now, login, app };
      const result = await matched.handler(ctx);
      if (!res.headersSent && !res.writableEnded) json(res, result ?? { ok: true });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : error instanceof URIError ? 400 : 500;
      if (status >= 500) log('error', 'Erro na requisição', { requestId, method: req.method, route: matched?.pattern, errorType: error.name, errorCode: error.code });
      if (res.headersSent) { res.end(); return; }
      json(res, { error: status >= 500 && !error.safe ? 'Erro interno. Informe o identificador ao suporte.' : error.message, requestId }, status);
    }
  };
  const server = config.tlsKey
    ? httpsServer({ key: readFileSync(config.tlsKey), cert: readFileSync(config.tlsCert), minVersion: 'TLSv1.2' }, handler)
    : httpServer(handler);
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 64;

  if (overrides.schedule !== false) {
    let running = false;
    const tasks = async () => {
      if (running) return;
      running = true;
      try {
        const jobs = {
          evaluations: () => sendDueEvaluations({ db, now, audit: auditFor(null), notify, app }),
          sessions: () => db.expireSessions(Date.now()),
          backup: () => {
            if (!config.demo && Date.now() - (Date.parse(lastBackup(config)) || 0) > config.backupHours * 3_600_000) return backupDatabase(db, config);
          }
        };
        for (const [job, run] of Object.entries(jobs)) {
          try { await run(); }
          catch (error) { log('error', 'Falha em tarefa de manutenção', { job, errorType: error.name, errorCode: error.code }); }
        }
      } finally { running = false; }
    };
    const interval = setInterval(tasks, 60_000);
    interval.unref();
    timers.push(() => clearInterval(interval));
  }
  server.once('close', () => {
    for (const stop of timers) stop();
    db.close();
  });
  return { server, config, db, startedAt };
}

export function start(overrides = {}) {
  const { server, config } = createApplication(overrides);
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? 'A porta ' + config.port + ' já está em uso.' : error.message);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log('Gestão de Capacitações disponível em ' + config.baseUrl);
    if (config.demo) console.log('Demonstração com dados fictícios. Feche esta janela para encerrar.');
  });
  return { server, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { start(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
