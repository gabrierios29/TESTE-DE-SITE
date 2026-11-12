import { constants, createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

const TTL = 10 * 60_000;
const timestamp = () => new Date().toISOString();
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const digits = value => String(value ?? '').replace(/\D/g, '');
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const number = value => value === '' || value == null ? null : Number(value);
const bindings = new Set();
const dispatches = new Set();
const tokens = new Map();
let certificateProvider;

class IntegrationError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function secureUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new IntegrationError('Endereço HTTPS inválido na configuração.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new IntegrationError('O conector exige um endereço HTTPS sem credenciais na URL.');
  }
  return url;
}

function optionalUrl(value) {
  try { return value ? secureUrl(value) : null; } catch { return null; }
}

async function jsonRequest(value, options = {}) {
  const { empty = false, ...request } = options;
  const url = secureUrl(value);
  let response;
  try {
    response = await fetch(url, { ...request, redirect: 'error', signal: AbortSignal.timeout(18_000) });
  } catch {
    throw new IntegrationError('Não foi possível acessar o serviço externo.', { retryable: true });
  }
  if (response.status === 404) throw new IntegrationError('Registro não encontrado no serviço externo.');
  if (!response.ok) {
    throw new IntegrationError(`O serviço externo retornou HTTP ${response.status}.`, {
      retryable: response.status >= 500 || [408, 429].includes(response.status)
    });
  }
  if (empty && response.status === 204) return {};
  try {
    const payload = await response.text();
    return empty && !payload.trim() ? {} : JSON.parse(payload);
  } catch {
    throw new IntegrationError('O serviço externo retornou uma resposta inválida.');
  }
}

async function bearer(prefix) {
  const direct = process.env[`${prefix}_TOKEN`];
  if (direct) return { Authorization: `Bearer ${direct}` };
  const endpoint = process.env[`${prefix}_TOKEN_URL`];
  if (!endpoint) return {};
  const cached = tokens.get(prefix);
  if (cached && cached.until > Date.now()) return { Authorization: `Bearer ${cached.token}` };
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new IntegrationError('Credenciais OAuth do conector ausentes.');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  if (process.env[`${prefix}_SCOPE`]) body.set('scope', process.env[`${prefix}_SCOPE`]);
  const result = await jsonRequest(endpoint, { method: 'POST', body });
  if (typeof result.access_token !== 'string' || String(result.token_type).toLowerCase() !== 'bearer') {
    throw new IntegrationError('O serviço de autenticação não forneceu um token Bearer.');
  }
  const seconds = Number(result.expires_in) || 60;
  tokens.set(prefix, { token: result.access_token, until: Date.now() + Math.max(0, seconds - 30) * 1000 });
  return { Authorization: `Bearer ${result.access_token}` };
}

export function institutionalAvailable(app) {
  const issuer = optionalUrl(process.env.OIDC_ISSUER);
  const redirect = optionalUrl(process.env.OIDC_REDIRECT_URI);
  return Boolean(!app?.demo && issuer && !issuer.search && redirect && !redirect.search &&
    redirect.pathname === '/api/auth/institutional/callback' && (!app?.baseUrl || redirect.origin === app.baseUrl) &&
    process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
}

async function discovery() {
  if (!institutionalAvailable()) throw new IntegrationError('O login institucional ainda precisa de configuração.');
  const issuer = secureUrl(process.env.OIDC_ISSUER);
  const configuration = await jsonRequest(`${issuer.href.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (configuration.issuer !== process.env.OIDC_ISSUER) {
    throw new IntegrationError('Emissor institucional divergente da configuração.');
  }
  secureUrl(configuration.authorization_endpoint);
  secureUrl(configuration.token_endpoint);
  secureUrl(configuration.jwks_uri);
  return configuration;
}

function addCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), cookie]);
}

function browserCookie(res, value, maxAge) {
  addCookie(res, `capacita_oidc=${value}; Path=/api/auth/institutional/callback; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const one = Buffer.from(a);
  const two = Buffer.from(b);
  return one.length === two.length && timingSafeEqual(one, two);
}

const signing = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } },
  ES256: { hash: 'sha256', kty: 'EC', options: { dsaEncoding: 'ieee-p1363' } }
};

async function claimsFrom(token, configuration, record) {
  const invalid = () => new IntegrationError('A identidade retornada pelo provedor institucional é inválida.');
  if (typeof token !== 'string' || token.length > 32_768) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { throw invalid(); }
  if (!header || !claims || header.crit != null) throw invalid();
  const allowed = (process.env.OIDC_SIGNING_ALGORITHMS || 'RS256').split(',').map(value => value.trim());
  const algorithm = signing[header.alg];
  if (!Object.hasOwn(signing, header.alg) || !allowed.includes(header.alg)) throw invalid();
  const jwks = await jsonRequest(configuration.jwks_uri);
  if (!Array.isArray(jwks.keys)) throw invalid();
  const candidates = jwks.keys.filter(key => key.kty === algorithm.kty && (!key.use || key.use === 'sig') &&
    (!key.alg || key.alg === header.alg) && (!header.kid || key.kid === header.kid) &&
    (!key.key_ops || key.key_ops.includes('verify')) && (header.alg !== 'ES256' || key.crv === 'P-256'));
  if (candidates.length !== 1) throw invalid();
  try {
    const key = createPublicKey({ key: candidates[0], format: 'jwk' });
    if (!verify(algorithm.hash, Buffer.from(parts.slice(0, 2).join('.')),
      { key, ...algorithm.options }, Buffer.from(parts[2], 'base64url'))) throw invalid();
  } catch { throw invalid(); }
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const client = process.env.OIDC_CLIENT_ID;
  if (claims.iss !== configuration.issuer || !audiences.includes(client) ||
      (audiences.length > 1 && claims.azp !== client) || (claims.azp != null && claims.azp !== client) ||
      !Number.isFinite(claims.exp) || claims.exp < now - 30 ||
      !Number.isFinite(claims.iat) || claims.iat > now + 30 || claims.iat < record.created / 1000 - 60 ||
      (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || !matches(claims.nonce, record.nonce)) {
    throw invalid();
  }
  return claims;
}

function registerOidc(app) {
  app.route('GET', '/api/auth/institutional/start', '*', async ctx => {
    if (app.demo) return ctx.fail(403, 'O login institucional fica disponível no ambiente configurado.');
    const redirectUri = optionalUrl(process.env.OIDC_REDIRECT_URI);
    if (!redirectUri || redirectUri.origin !== app.baseUrl ||
        redirectUri.pathname !== '/api/auth/institutional/callback' || redirectUri.search) {
      return ctx.fail(503, 'Cadastre o endereço de retorno HTTPS do sistema no provedor institucional.');
    }
    let configuration;
    try { configuration = await discovery(); }
    catch (error) { return ctx.fail(503, error.message); }
    const state = random();
    const verifier = random();
    const proof = random();
    const record = { id: digest(state), nonce: random(), verifier, proof: digest(proof), created: Date.now() };
    ctx.db.tx(() => {
      for (const expired of ctx.db.list('oidcAttempts').filter(item => item.created < Date.now() - TTL)) {
        ctx.db.remove('oidcAttempts', expired.id);
      }
      if (ctx.db.list('oidcAttempts').length >= 500) return ctx.fail(429, 'Tente novamente em alguns minutos.');
      ctx.db.save('oidcAttempts', record);
    });
    const target = secureUrl(configuration.authorization_endpoint);
    const params = {
      client_id: process.env.OIDC_CLIENT_ID, redirect_uri: process.env.OIDC_REDIRECT_URI,
      response_type: 'code', scope: 'openid', state, nonce: record.nonce,
      code_challenge: digest(verifier), code_challenge_method: 'S256'
    };
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    browserCookie(ctx.res, proof, TTL / 1000);
    redirect(ctx.res, target.href);
  }, 'Inicia autenticação OpenID Connect institucional');

  app.route('GET', '/api/auth/institutional/callback', '*', async ctx => {
    if (app.demo) return ctx.fail(403, 'O login institucional fica disponível no ambiente configurado.');
    const query = ctx.query instanceof URLSearchParams ? Object.fromEntries(ctx.query) : ctx.query;
    const state = text(query.state, 128);
    const code = text(query.code, 8_192);
    const proof = (ctx.req.headers.cookie || '').match(/(?:^|;\s*)capacita_oidc=([A-Za-z0-9_-]+)(?:;|$)/)?.[1];
    const record = state && proof ? ctx.db.get('oidcAttempts', digest(state)) : null;
    browserCookie(ctx.res, '', 0);
    if (!record || record.created < Date.now() - TTL || !matches(record.proof, digest(proof || ''))) {
      return ctx.fail(400, 'Sessão de login institucional inválida ou expirada.');
    }
    ctx.db.remove('oidcAttempts', record.id);
    if (!code || query.error) return ctx.fail(401, 'O provedor institucional não autorizou o acesso.');
    let claims;
    try {
      const configuration = await discovery();
      const body = new URLSearchParams({
        code, grant_type: 'authorization_code', code_verifier: record.verifier,
        redirect_uri: process.env.OIDC_REDIRECT_URI
      });
      const headers = {};
      if (process.env.OIDC_TOKEN_AUTH_METHOD === 'client_secret_post') {
        body.set('client_id', process.env.OIDC_CLIENT_ID);
        body.set('client_secret', process.env.OIDC_CLIENT_SECRET);
      } else {
        const encoded = new URLSearchParams([[process.env.OIDC_CLIENT_ID, process.env.OIDC_CLIENT_SECRET]]).toString();
        const colonSeparated = encoded.replace('=', ':');
        headers.Authorization = `Basic ${Buffer.from(colonSeparated).toString('base64')}`;
      }
      const token = await jsonRequest(configuration.token_endpoint, { method: 'POST', body, headers });
      claims = await claimsFrom(token.id_token, configuration, record);
    } catch (error) {
      return ctx.fail(error instanceof IntegrationError ? 401 : 502,
        error instanceof IntegrationError ? error.message : 'Falha no login institucional.');
    }
    const users = ctx.db.list('users').filter(user => user.active !== false && user.oidcSubject === claims.sub);
    if (users.length !== 1) return ctx.fail(403, 'Vincule a identidade institucional a um usuário ativo na administração.');
    ctx.login(users[0].id);
    redirect(ctx.res, '/');
  }, 'Valida o retorno OpenID Connect e inicia sessão');
}

export async function lookupServant(ctx, { cpf, matricula }) {
  const cpfNumber = digits(cpf);
  const registration = text(matricula, 80);
  if (cpfNumber.length !== 11 || !registration) return ctx.fail(400, 'Informe CPF e matrícula funcional.');
  const matchesLocal = servant => digits(servant.cpf) === cpfNumber &&
    text(servant.matricula).toUpperCase() === registration.toUpperCase();
  const local = ctx.db.list('servants').find(matchesLocal);
  const endpoint = !ctx.app?.demo && process.env.SERVERS_API_URL;
  if (local?.active !== false && (local?.validatedAt || (!endpoint && local))) return local;
  if (!endpoint) return null;
  let result;
  try {
    result = await jsonRequest(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...await bearer('SERVERS') },
      body: JSON.stringify({ cpf: cpfNumber, matricula: registration })
    });
  } catch (error) {
    if (error.message === 'Registro não encontrado no serviço externo.') return null;
    return ctx.fail(502, error instanceof IntegrationError ? error.message : 'Falha na consulta à base funcional.');
  }
  const person = result?.servidor ?? result;
  if (!person || person.encontrado === false || person.ativo === false || person.active === false) return null;
  const data = {
    cpf: digits(person.cpf), matricula: text(person.matricula, 80), name: text(person.nome ?? person.name),
    org: text(person.orgao ?? person.org), unit: text(person.unidade ?? person.unit),
    email: text(person.email, 254), functionalId: text(person.identificadorFuncional ?? person.functionalId, 150),
    moodleUserId: text(person.moodleUserId, 30), validatedAt: timestamp(), source: 'base-funcional', active: true
  };
  if (!matchesLocal(data) || !data.name || !data.org || !data.functionalId) {
    return ctx.fail(502, 'A base funcional retornou dados divergentes ou incompletos.');
  }
  if (!withinScope(ctx, data)) return ctx.fail(404, 'Servidor ativo não localizado com o CPF e a matrícula informados.');
  return ctx.db.tx(() => {
    const servants = ctx.db.list('servants');
    const latest = servants.find(matchesLocal);
    if (servants.some(item => item.id !== latest?.id && item.functionalId === data.functionalId)) {
      return ctx.fail(409, 'O identificador funcional retornado já está vinculado a outro cadastro.');
    }
    const saved = ctx.db.save('servants', { ...latest, ...data, moodleUserId: data.moodleUserId || latest?.moodleUserId || '' });
    ctx.audit('servant.verified', 'servants', saved.id, { source: 'base-funcional' });
    return saved;
  });
}

function job(db, service, key, payload, at = timestamp()) {
  const record = { id: randomUUID(), service, key, payload, status: 'pending', attempts: 0, createdAt: at, nextAt: at };
  return db.save('integrationJobs', record);
}

export function queueEmail(db, { id, userId, to, subject, text: message, link, createdAt }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to || '')) return null;
  const key = `email:${id || randomUUID()}`;
  const existing = db.list('integrationJobs').find(item => item.key === key);
  return existing || job(db, 'email', key, {
    userId, to: text(to, 254), subject: text(subject, 180), message: text(message, 10_000), link: text(link, 1_000)
  }, createdAt);
}

export function setCanalCertificateProvider(provider) {
  certificateProvider = provider;
}

export function queueCanal(db, { registration, certificate, classRecord, action, operation = 'upsert' }) {
  if (!registration?.id || !classRecord?.id || !action?.id) return null;
  const key = `canal:${registration.id}`;
  const payload = {
    operation, registrationId: registration.id, servantId: registration.servantId,
    classId: classRecord.id, actionId: action.id, certificateId: certificate?.id ?? null,
    certificateCode: certificate?.code ?? '', title: action.title, modality: action.modality,
    startDate: classRecord.startDate ?? action.startDate, endDate: classRecord.endDate ?? action.endDate,
    hours: certificate?.snapshot?.hours ?? classRecord.hours ?? action.hours
  };
  const previous = db.list('integrationJobs').filter(item => item.key === key && item.status !== 'superseded');
  const latest = previous.at(-1);
  if (latest && JSON.stringify(latest.payload) === JSON.stringify(payload)) return latest;
  for (const item of previous) {
    if (['pending', 'rejected'].includes(item.status)) {
      db.save('integrationJobs', { ...item, status: 'superseded', finishedAt: timestamp() });
    }
  }
  return job(db, 'canal', key, payload);
}

export function queueCanalRegistration(db, registration, classRecord, action) {
  classRecord ??= db.get('classes', registration.classId);
  action ??= db.get('actions', classRecord?.actionId);
  if (!classRecord || !action) return null;
  const relevant = db.list('certificates').filter(item => item.registrationId === registration.id);
  const certificate = relevant.find(item => item.status === 'active');
  const canceled = relevant.filter(item => item.status === 'revoked').at(-1);
  const completed = registration.completion === 'completed' && registration.status === 'confirmed' && classRecord.status === 'completed';
  if (!certificate && !canceled && !completed &&
      !db.list('integrationJobs').some(item => item.service === 'canal' && item.payload.registrationId === registration.id)) {
    return null;
  }
  return queueCanal(db, { registration, classRecord, action, certificate: certificate ?? canceled,
    operation: !completed || (!certificate && canceled) ? 'cancel' : 'upsert' });
}

function serviceEndpoint(service) {
  return process.env[service === 'email' ? 'EMAIL_API_URL' : 'CANAL_API_URL'];
}

function absoluteLink(link, base) {
  if (!link) return '';
  if (/^#[\w/-]+/.test(link) && base) return new URL(link, base).href;
  if (link.startsWith('/') && !link.startsWith('//') && base) return new URL(link, base).href;
  return optionalUrl(link)?.href || '';
}

async function sendJob(app, record) {
  const data = record.payload;
  const prefix = record.service === 'email' ? 'EMAIL' : 'CANAL';
  let payload;
  if (record.service === 'email') {
    const link = absoluteLink(data.link, app.baseUrl);
    payload = {
      to: data.to, from: process.env.EMAIL_FROM || undefined,
      subject: data.subject, text: link && !data.message.includes(link) ? `${data.message}\n\n${link}` : data.message, link
    };
  } else {
    const registration = app.db.get('registrations', data.registrationId);
    const servant = app.db.get('servants', data.servantId || registration?.servantId);
    if (!servant?.functionalId || !servant.validatedAt) {
      throw new IntegrationError('O cadastro funcional ainda precisa de um identificador validado.');
    }
    payload = {
      operacao: data.operation, idRegistro: record.key, identificadorFuncional: servant.functionalId,
      idCapacitacao: data.actionId, idTurma: data.classId,
      titulo: data.title, modalidade: data.modality, inicio: data.startDate, termino: data.endDate,
      cargaHoraria: data.hours, codigoCertificado: data.certificateCode || undefined
    };
    if (data.operation === 'upsert' && data.certificateId) {
      const certificate = app.db.get('certificates', data.certificateId);
      if (!certificate || !certificateProvider) throw new IntegrationError('PDF do certificado indisponível para envio.');
      const pdf = await certificateProvider(certificate, { db: app.db, baseUrl: app.baseUrl });
      if (!pdf) throw new IntegrationError('PDF do certificado indisponível para envio.');
      payload.certificadoPdfBase64 = Buffer.from(pdf).toString('base64');
    }
  }
  const result = await jsonRequest(serviceEndpoint(record.service), {
    method: 'POST', empty: true,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': record.id, ...await bearer(prefix) },
    body: JSON.stringify(payload)
  });
  if (result?.accepted === false || result?.success === false || result?.aceito === false || result?.error ||
      ['failed', 'rejected', 'error'].includes(result?.status)) {
    throw new IntegrationError('O serviço externo rejeitou os dados transmitidos.');
  }
  return text(result?.id ?? result?.protocolo ?? result?.messageId, 180);
}

function publicJob(record) {
  return {
    id: record.id, service: record.service, key: record.service === 'canal' ? record.key : null,
    subject: record.payload.subject || record.payload.title, operation: record.payload.operation,
    status: record.status, attempts: record.attempts, error: record.error, createdAt: record.createdAt,
    finishedAt: record.finishedAt, lastAttempt: record.lastAttempt, remoteId: record.remoteId
  };
}

async function dispatch(app, record) {
  if (app.demo || !serviceEndpoint(record.service) || dispatches.has(record.key)) return publicJob(record);
  const started = app.db.save('integrationJobs', {
    ...record, status: 'sending', attempts: record.attempts + 1, lastAttempt: timestamp()
  });
  dispatches.add(record.key);
  let result;
  try {
    const remoteId = await sendJob(app, started);
    result = { ...started, status: 'sent', remoteId, error: null, finishedAt: timestamp() };
  } catch (error) {
    const retry = error.retryable === true && started.attempts < 5;
    result = {
      ...started, status: retry ? 'pending' : 'rejected',
      error: error instanceof IntegrationError ? error.message : 'Falha no processamento do conector.',
      nextAt: new Date(Date.now() + Math.min(60, 2 ** started.attempts) * 60_000).toISOString(),
      finishedAt: retry ? null : timestamp()
    };
  } finally {
    dispatches.delete(record.key);
  }
  const newer = app.db.list('integrationJobs').some(item => item.key === record.key && item.id !== record.id &&
    item.createdAt >= record.createdAt && item.status === 'pending');
  return app.db.tx(() => {
    const saved = app.db.save('integrationJobs', {
      ...result, status: newer && result.status !== 'sent' ? 'superseded' : result.status
    });
    app.audit?.('integration.attempt', 'integrationJobs', saved.id, {
      service: saved.service, status: saved.status, attempt: saved.attempts, error: saved.error
    });
    return publicJob(saved);
  });
}

async function runPending(app, service) {
  const due = app.db.list('integrationJobs').filter(item => (!service || item.service === service) &&
    item.status === 'pending' && item.nextAt <= timestamp() && serviceEndpoint(item.service)).slice(0, 20);
  return Promise.all(due.map(item => dispatch(app, item)));
}

function withinScope(ctx, record) {
  if (typeof ctx.scope === 'function') return ctx.scope(record);
  const user = ctx.user;
  const org = user.scopeOrg || (user.role === 'focal' ? user.org : '');
  return (!org || org === record.org) &&
    (!user.scopeUnit || user.scopeUnit === record.unit);
}

const globalAdmin = user => user.role === 'admin' && !user.scopeOrg && !user.scopeUnit;

function jobInScope(ctx, record) {
  if (record.service === 'canal') {
    const action = ctx.db.get('actions', record.payload.actionId);
    return Boolean(action && withinScope(ctx, action));
  }
  const user = record.payload.userId && ctx.db.get('users', record.payload.userId);
  return user ? withinScope(ctx, user) : globalAdmin(ctx.user);
}

const positiveId = value => /^\d{1,14}$/.test(String(value)) && Number(value) > 0;
const online = action => /online|ead|dist.ncia/i.test(action?.modality ?? '');
const virtual = action => online(action) || /h.brid/i.test(action?.modality ?? '');
const dateSeconds = date => Math.floor(new Date(`${date}T00:00:00-03:00`).getTime() / 1000);

function moodleAvailable() {
  const base = optionalUrl(process.env.MOODLE_URL);
  return Boolean(base && !base.search && process.env.MOODLE_TOKEN);
}

function moodleUrl(path) {
  const base = secureUrl(process.env.MOODLE_URL);
  return new URL(path, `${base.href.replace(/\/$/, '')}/`).href;
}

function moodleParams(params, key, value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    for (const [part, child] of Object.entries(value)) moodleParams(params, key ? `${key}[${part}]` : part, child);
  } else if (value != null) {
    params.set(key, String(value));
  }
}

async function moodle(method, payload) {
  const body = new URLSearchParams({
    wstoken: process.env.MOODLE_TOKEN, moodlewsrestformat: 'json', wsfunction: method
  });
  moodleParams(body, '', payload);
  const result = await jsonRequest(moodleUrl('webservice/rest/server.php'), { method: 'POST', body });
  if (result?.exception || result?.errorcode) {
    const errorCode = String(result.errorcode ?? '');
    const suffix = /^[a-z0-9_]{1,80}$/i.test(errorCode) ? ` (${errorCode})` : '';
    throw new IntegrationError(`A função ${method} retornou erro${suffix}.`);
  }
  return result;
}

function moodleClass(ctx, id) {
  const classRecord = ctx.db.get('classes', id);
  const action = classRecord && ctx.db.get('actions', classRecord.actionId);
  if (!classRecord || !action || !withinScope(ctx, { ...action, ...classRecord })) {
    return ctx.fail(404, 'Turma não encontrada.');
  }
  if (!virtual(action)) return ctx.fail(422, 'A turma deve pertencer a uma ação EaD ou híbrida.');
  return { classRecord, action };
}

async function fetchCourse(field, value) {
  const response = await moodle('core_course_get_courses_by_field', { field, value });
  if (response?.courses?.length > 1) throw new IntegrationError('O identificador corresponde a mais de um curso no Moodle.');
  return response?.courses?.[0] ?? null;
}

function courseFields(classRecord, action) {
  return {
    fullname: text(`${action.title} · ${classRecord.title || 'Turma'}`, 254),
    startdate: dateSeconds(classRecord.startDate ?? action.startDate),
    enddate: dateSeconds(classRecord.endDate ?? action.endDate)
  };
}

function withValidDates(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value !== 'number' || Number.isFinite(value)));
}

async function linkCourse(ctx, classRecord, action) {
  let course;
  const requested = ctx.body.courseId || classRecord.moodleCourseId;
  const externalId = `IMPARH-${classRecord.id}`;
  if (requested) {
    if (!positiveId(requested)) throw new IntegrationError('Informe o ID numérico do curso Moodle.');
    course = await fetchCourse('id', requested);
    if (!course) throw new IntegrationError('Curso não encontrado no Moodle.');
  } else {
    const category = process.env.MOODLE_CATEGORY_ID;
    if (!ctx.body.create || !positiveId(category)) {
      throw new IntegrationError('Informe um curso existente ou configure a categoria para criar a sala.');
    }
    course = await fetchCourse('idnumber', externalId);
    if (!course) {
      const created = await moodle('core_course_create_courses', {
        courses: [withValidDates({
          ...courseFields(classRecord, action), categoryid: Number(category), shortname: externalId,
          idnumber: externalId, enablecompletion: 1, visible: 0
        })]
      });
      course = created?.[0];
    }
  }
  if (!positiveId(course?.id)) throw new IntegrationError('O Moodle não retornou o ID do curso.');
  return ctx.db.tx(() => {
    const latest = ctx.db.get('classes', classRecord.id);
    if (!latest) return ctx.fail(404, 'Turma não encontrada.');
    if (ctx.db.list('classes').some(item => item.id !== classRecord.id && String(item.moodleCourseId) === String(course.id))) {
      return ctx.fail(409, 'Já existe uma turma vinculada a esse curso Moodle.');
    }
    const virtualUrl = moodleUrl(`course/view.php?id=${course.id}`);
    const updated = ctx.db.save('classes', {
      ...latest, moodleCourseId: Number(course.id), moodleTitle: text(course.fullname, 254) ||
        courseFields(classRecord, action).fullname, virtualUrl
    });
    ctx.audit('moodle.link', 'classes', latest.id, { courseId: course.id });
    return { id: updated.id, courseId: updated.moodleCourseId, virtualUrl };
  });
}

function normalizedProgress(completion, activities, grades, localProgress, classRecord, action) {
  const flag = localProgress?.completed ?? completion?.completionstatus?.completed;
  const completed = [true, false, 0, 1].includes(flag) ? Boolean(flag) : null;
  const items = Array.isArray(activities?.statuses) ? activities.statuses.slice(0, 500).map(status => ({
    id: status.cmid, state: status.state, completedAt: status.timecompleted || null
  })) : [];
  const grade = grades?.usergrades?.[0]?.gradeitems?.find(item => item.itemtype === 'course');
  const rawGrade = number(grade?.graderaw);
  const gradeMin = number(grade?.grademin) ?? 0;
  const gradeMax = number(grade?.grademax);
  const maxScale = 100;
  const scaled = Number.isFinite(rawGrade) && Number.isFinite(gradeMin) && Number.isFinite(gradeMax) && gradeMax > gradeMin ?
    Math.round(Math.min(maxScale, Math.max(0, (rawGrade - gradeMin) / (gradeMax - gradeMin) * maxScale)) * 100) / 100 : null;
  const attendance = number(localProgress?.attendancePercent);
  const directHours = number(localProgress?.completedHours);
  const planned = number(classRecord.virtualPlannedHours) ?? (online(action) ? number(classRecord.hours ?? action.hours) : null);
  const hours = Number.isFinite(directHours) && directHours >= 0 ? directHours :
    completed === true && Number.isFinite(planned) && planned >= 0 ? planned : null;
  return {
    completed, activities: items, grade: scaled, hours,
    attendance: Number.isFinite(attendance) && attendance >= 0 && attendance <= 100 ? attendance : null
  };
}

async function findMoodleUsers(registrations, ctx, courseUsers, push, divergences) {
  const resolved = [];
  for (const registration of registrations) {
    const servant = ctx.db.get('servants', registration.servantId);
    const key = text(registration.matricula ?? servant?.matricula, 80);
    const known = [registration.moodle?.userId, servant?.moodleUserId].find(positiveId);
    const byExternalKey = key ? courseUsers.filter(item => text(item.idnumber, 80).toUpperCase() === key.toUpperCase()) : [];
    let userId = known ? Number(known) : byExternalKey.length === 1 ? Number(byExternalKey[0].id) : null;
    if (!userId && push && key) {
      const external = await moodle('core_user_get_users_by_field', { field: 'idnumber', values: [key] });
      if (Array.isArray(external) && external.length === 1) userId = Number(external[0].id);
    }
    if (!positiveId(userId)) {
      divergences.push({ registrationId: registration.id, name: registration.name,
        issue: 'Identidade Moodle ausente ou ambígua para a matrícula.' });
      continue;
    }
    resolved.push({ registration, userId, enrolled: courseUsers.some(item => Number(item.id) === userId) });
  }
  const ambiguous = new Set(resolved.filter((item, index) =>
    resolved.findIndex(other => other.userId === item.userId) !== index).map(item => item.userId));
  for (const item of resolved.filter(item => ambiguous.has(item.userId))) {
    divergences.push({ registrationId: item.registration.id, name: item.registration.name,
      issue: 'A identidade Moodle está associada a mais de uma inscrição da turma.' });
  }
  return resolved.filter(item => !ambiguous.has(item.userId));
}

async function fetchProgress(item, courseId, classRecord, action, options, divergences) {
  const params = { courseid: courseId, userid: item.userId };
  const functions = [
    'core_completion_get_course_completion_status',
    options.activities ? 'core_completion_get_activities_completion_status' : null,
    options.grades ? 'gradereport_user_get_grade_items' : null,
    /^[a-z][a-z0-9_]{3,80}$/.test(process.env.MOODLE_PROGRESS_FUNCTION || '') ? process.env.MOODLE_PROGRESS_FUNCTION : null
  ];
  const reads = await Promise.allSettled(functions.map(method => method ? moodle(method, params) : null));
  for (const result of reads.filter(result => result.status === 'rejected')) {
    divergences.push({ registrationId: item.registration.id, name: item.registration.name,
      issue: result.reason instanceof IntegrationError ? result.reason.message : 'Falha ao obter progresso no Moodle.' });
  }
  return { ...item, ...normalizedProgress(...reads.map(result => result.value), classRecord, action) };
}

async function syncMoodle(ctx, classRecord, action) {
  const courseId = Number(classRecord.moodleCourseId);
  if (!positiveId(courseId)) throw new IntegrationError('Vincule a turma a um curso Moodle antes de sincronizar.');
  const options = ctx.body;
  const course = await fetchCourse('id', courseId);
  if (!course) throw new IntegrationError('Curso vinculado não encontrado no Moodle.');
  if (options.updateCourse) {
    await moodle('core_course_update_courses', { courses: [{ id: courseId, ...withValidDates(courseFields(classRecord, action)) }] });
  }
  const courseUsers = await moodle('core_enrol_get_enrolled_users', { courseid: courseId });
  if (!Array.isArray(courseUsers)) throw new IntegrationError('Não foi possível interpretar a lista de matriculados do Moodle.');
  const registrations = ctx.db.list('registrations').filter(item => item.classId === classRecord.id &&
    item.status === 'confirmed' && withinScope(ctx, item));
  const divergences = [];
  const resolved = await findMoodleUsers(registrations, ctx, courseUsers, options.enrol, divergences);
  if (options.enrol) {
    const roleId = process.env.MOODLE_STUDENT_ROLE_ID;
    if (!positiveId(roleId)) throw new IntegrationError('Configure o ID do papel de estudante no Moodle.');
    const missing = resolved.filter(item => !item.enrolled);
    for (let offset = 0; offset < missing.length; offset += 40) {
      const group = missing.slice(offset, offset + 40);
      await moodle('enrol_manual_enrol_users', {
        enrolments: group.map(item => ({ roleid: roleId, userid: item.userId, courseid: courseId }))
      });
      for (const item of group) item.enrolled = true;
    }
  }
  for (const item of resolved.filter(item => !item.enrolled)) {
    divergences.push({ registrationId: item.registration.id, name: item.registration.name,
      issue: 'Inscrição confirmada no sistema sem matrícula no Moodle.' });
  }
  const known = new Set(resolved.map(item => item.userId));
  const externalRoster = ctx.user.scopeOrg || ctx.user.scopeUnit || ctx.user.role === 'focal' ? [] : courseUsers;
  for (const item of externalRoster) {
    if (known.has(Number(item.id))) continue;
    if (Array.isArray(item.roles) && item.roles.length &&
      !item.roles.some(role => Number(role.roleid || role.id) === Number(process.env.MOODLE_STUDENT_ROLE_ID) || role.shortname === 'student')) continue;
    divergences.push({ moodleUserId: item.id, issue: 'Matrícula Moodle sem inscrição confirmada no sistema.' });
  }
  if (!options.updateCourse && (course.startdate && course.startdate !== dateSeconds(classRecord.startDate ?? action.startDate) ||
      course.enddate && course.enddate !== dateSeconds(classRecord.endDate ?? action.endDate))) {
    divergences.push({ issue: 'Período do curso Moodle diverge das datas da turma.' });
  }
  const progress = [];
  const enrolled = resolved.filter(item => item.enrolled);
  for (let offset = 0; offset < enrolled.length; offset += 4) {
    progress.push(...await Promise.all(enrolled.slice(offset, offset + 4).map(
      item => fetchProgress(item, courseId, classRecord, action, options, divergences)
    )));
  }
  const at = timestamp();
  return ctx.db.tx(() => {
    let updated = 0;
    const latestClass = ctx.db.get('classes', classRecord.id);
    if (latestClass?.moodleCourseId !== classRecord.moodleCourseId) return ctx.fail(409, 'O vínculo com o Moodle foi alterado.');
    ctx.db.save('classes', { ...latestClass, moodleSyncedAt: at, moodleTitle: options.updateCourse ?
      courseFields(classRecord, action).fullname : text(course.fullname, 254) || latestClass.moodleTitle });
    for (const remote of progress) {
      const current = ctx.db.get('registrations', remote.registration.id);
      if (current?.status !== 'confirmed' || current.classId !== classRecord.id) continue;
      const completion = remote.completed === true && latestClass.status === 'completed' && online(action) ? 'completed' :
        remote.completed === false && latestClass.status === 'completed' ? 'not_completed' : current.completion;
      if ((remote.completed === false && current.completion === 'completed') ||
          (remote.completed === true && current.completion === 'not_completed')) {
        divergences.push({ registrationId: current.id, name: current.name, issue: 'Conclusão local diverge do resultado do Moodle.' });
      }
      if (remote.grade != null && current.grade != null && Number(current.grade) !== remote.grade) {
        divergences.push({ registrationId: current.id, name: current.name, issue: 'Nota local diverge da nota consolidada do Moodle.' });
      }
      const importGrade = remote.grade != null && (current.grade == null || current.gradeSource === 'moodle');
      const saved = ctx.db.save('registrations', {
        ...current, completion,
        virtualHours: remote.hours ?? current.virtualHours,
        virtualAttendance: remote.attendance ?? current.virtualAttendance,
        grade: importGrade ? remote.grade : current.grade,
        gradeSource: importGrade ? 'moodle' : current.gradeSource,
        moodle: { courseId, userId: remote.userId, completed: remote.completed, activities: remote.activities,
          grade: remote.grade, hours: remote.hours, attendance: remote.attendance, syncedAt: at }
      });
      queueCanalRegistration(ctx.db, saved, latestClass, action);
      updated += 1;
    }
    const report = { classId: classRecord.id, courseId, status: divergences.length ? 'partial' : 'sent',
      org: action.org, unit: action.unit, updated, divergences, createdAt: at };
    const run = ctx.db.save('moodleRuns', report);
    ctx.audit('moodle.sync', 'classes', classRecord.id, { courseId, updated, divergences: divergences.length });
    return run;
  });
}

async function withMoodle(ctx, operation) {
  if (ctx.app?.demo || !moodleAvailable()) return ctx.fail(503, 'Configure MOODLE_URL e MOODLE_TOKEN para usar o AVEA.');
  const id = ctx.params.id;
  if (bindings.has(id)) return ctx.fail(409, 'Há uma operação Moodle em andamento para esta turma.');
  const records = moodleClass(ctx, id);
  bindings.add(id);
  try {
    return await operation(ctx, records.classRecord, records.action);
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    const { classRecord, action } = records;
    ctx.db.save('moodleRuns', { classId: id, courseId: classRecord.moodleCourseId,
      org: action.org, unit: action.unit, status: 'rejected', updated: 0, createdAt: timestamp(),
      divergences: [{ issue: error.message }] });
    ctx.audit('moodle.error', 'classes', id, { error: error.message });
    return ctx.fail(502, error.message);
  } finally {
    bindings.delete(id);
  }
}

export function startIntegrationRunner(app) {
  for (const interrupted of app.db.list('integrationJobs').filter(item => item.status === 'sending')) {
    app.db.save('integrationJobs', { ...interrupted, status: 'pending', nextAt: timestamp() });
  }
  if (app.demo || process.env.INTEGRATION_AUTO_DISPATCH !== 'true') return null;
  const interval = setInterval(() => runPending(app).catch(() => {
    process.stderr.write('Falha ao executar a fila de integrações.\n');
  }), 30_000);
  interval.unref();
  return interval;
}

function reconcileCanal(ctx) {
  return ctx.db.tx(() => {
    const actions = new Map(ctx.db.list('actions').filter(item => withinScope(ctx, item)).map(item => [item.id, item]));
    const classes = new Map(ctx.db.list('classes').filter(item => actions.has(item.actionId)).map(item => [item.id, item]));
    let total = 0;
    for (const registration of ctx.db.list('registrations')) {
      const classRecord = classes.get(registration.classId);
      const action = classRecord && actions.get(classRecord.actionId);
      if (!classRecord || !action || !withinScope(ctx, { ...action, ...classRecord })) continue;
      if (queueCanalRegistration(ctx.db, registration, classRecord, action)) total += 1;
    }
    ctx.audit('canal.reconcile', 'integrationJobs', null, { total });
    return { total };
  });
}

export function registerIntegrations(app) {
  registerOidc(app);
  app.route('GET', '/api/integrations', 'integrations.read', ctx => {
    const actions = new Map(ctx.db.list('actions').filter(item => virtual(item) && withinScope(ctx, item)).map(item => [item.id, item]));
    const classes = ctx.db.list('classes').filter(item => actions.has(item.actionId) &&
      withinScope(ctx, { ...actions.get(item.actionId), ...item })).map(item => ({
        id: item.id, title: item.title, action: actions.get(item.actionId).title,
        courseId: item.moodleCourseId, virtualUrl: item.virtualUrl, status: item.status
      }));
    const classIds = new Set(classes.map(item => item.id));
    const jobs = ctx.db.list('integrationJobs').filter(item => jobInScope(ctx, item));
    const registrations = new Set(ctx.db.list('registrations').filter(item => withinScope(ctx, item)).map(item => item.id));
    const restricted = ctx.user.scopeOrg || ctx.user.scopeUnit || ctx.user.role === 'focal';
    const runs = ctx.db.list('moodleRuns').filter(item => classIds.has(item.classId)).map(item => ({
      ...item, divergences: restricted ? item.divergences.filter(issue => !issue.moodleUserId &&
        (!issue.registrationId || registrations.has(issue.registrationId))) : item.divergences
    }));
    return {
      services: {
        institutional: institutionalAvailable(app), servers: !app.demo && Boolean(optionalUrl(process.env.SERVERS_API_URL)),
        moodle: !app.demo && moodleAvailable(), moodleCreate: !app.demo && positiveId(process.env.MOODLE_CATEGORY_ID),
        canal: !app.demo && Boolean(optionalUrl(process.env.CANAL_API_URL)), email: !app.demo && Boolean(optionalUrl(process.env.EMAIL_API_URL)),
        auto: !app.demo && process.env.INTEGRATION_AUTO_DISPATCH === 'true'
      },
      jobs: jobs.map(publicJob).reverse(), classes, runs: runs.slice(-30).reverse()
    };
  }, 'Consulta a configuração, as turmas Moodle, as divergências e as transmissões autorizadas');
  app.route('POST', '/api/integrations/moodle/:id/link', 'integrations.write',
    ctx => withMoodle(ctx, linkCourse), 'Vincula curso Moodle pelo ID ou cria uma sala na categoria configurada');
  app.route('POST', '/api/integrations/moodle/:id/sync', 'integrations.write',
    ctx => withMoodle(ctx, syncMoodle), 'Concilia inscrições, conclusão, atividades, resultados e carga horária do Moodle');
  app.route('GET', '/api/integrations/moodle/:id/progress', 'integrations.read', ctx => {
    const { classRecord } = moodleClass(ctx, ctx.params.id);
    const registrations = ctx.db.list('registrations').filter(item => item.classId === classRecord.id &&
      withinScope(ctx, item) && item.moodle && (item.moodle.courseId === classRecord.moodleCourseId || !item.moodle.courseId));
    return { participants: registrations.map(({ name, moodle }) => ({
      name, completed: moodle.completed, activities: moodle.activities,
      grade: moodle.grade, hours: moodle.hours, attendance: moodle.attendance, syncedAt: moodle.syncedAt
    })) };
  }, 'Consulta os resultados Moodle importados por turma, sem consultar o serviço remoto');
  app.route('POST', '/api/integrations/canal/reconcile', 'integrations.write', ctx => {
    if (!globalAdmin(ctx.user)) return ctx.fail(403, 'A preparação da fila exige administrador com escopo global.');
    return reconcileCanal(ctx);
  }, 'Prepara a transmissão de conclusões, certificados e invalidações ao Canal do Servidor');
  app.route('POST', '/api/integrations/jobs/run', 'integrations.write', async ctx => {
    if (!globalAdmin(ctx.user)) return ctx.fail(403, 'O processamento da fila exige administrador com escopo global.');
    const service = ctx.body.service;
    if (!['canal', 'email'].includes(service)) return ctx.fail(400, 'Selecione o serviço.');
    if (app.demo || !optionalUrl(serviceEndpoint(service))) return ctx.fail(503, 'Configure o endereço HTTPS do serviço para processar a fila.');
    const jobs = ctx.db.list('integrationJobs').filter(item => item.service === service && item.status === 'pending' &&
      item.nextAt <= timestamp() && jobInScope(ctx, item)).slice(0, 20);
    const results = await Promise.all(jobs.map(item => dispatch(app, item)));
    ctx.audit('integration.dispatch', 'integrationJobs', null, { service, total: results.length });
    return { results };
  }, 'Processa transmissões pendentes de um serviço configurado');
  app.route('POST', '/api/integrations/jobs/:id/retry', 'integrations.write', async ctx => {
    if (!globalAdmin(ctx.user)) return ctx.fail(403, 'O reenvio exige administrador com escopo global.');
    const record = ctx.db.get('integrationJobs', ctx.params.id);
    if (!record || !jobInScope(ctx, record)) return ctx.fail(404, 'Registro de transmissão não encontrado.');
    if (!['pending', 'rejected'].includes(record.status)) return ctx.fail(409, 'A transmissão já está em andamento ou finalizada.');
    if (app.demo || !optionalUrl(serviceEndpoint(record.service))) return ctx.fail(503, 'Configure o endereço HTTPS do serviço para reenviar.');
    const result = await dispatch(app, { ...record, status: 'pending', nextAt: timestamp() });
    ctx.audit('integration.retry', 'integrationJobs', record.id, { service: record.service, status: result.status });
    return result;
  }, 'Reenvia uma transmissão pendente ou rejeitada com a mesma chave de idempotência');
  const interval = startIntegrationRunner(app);
  if (interval && app.onClose) app.onClose(() => clearInterval(interval));
}
