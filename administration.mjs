import { capabilityNames, normalizeEmail, passwordHash, profiles, publicUser, roleNames } from './security.mjs';
import { backupDatabase, lastBackup } from './maintenance.mjs';

const nameText = (value, length = 180) => String(value ?? '').trim().slice(0, length);
const validEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const globalAdmin = (ctx) => {
  if (ctx.user.role !== 'admin' || ctx.user.scopeOrg || ctx.user.scopeUnit) ctx.fail(403, 'Operação exclusiva da administração geral.');
};
const person = ({ passwordHash: stored, ...item }) => ({ ...item, hasPassword: Boolean(stored) });
const pick = (type, id, db) => {
  const item = db.get(type, id);
  return item ? { id: item.id, name: item.name, org: item.org, unit: item.unit } : null;
};

export function provisionAdministrator(db) {
  if (db.list('users').length) return;
  const email = normalizeEmail(process.env.CAP_ADMIN_EMAIL);
  const password = process.env.CAP_ADMIN_PASSWORD || '';
  const oidcSubject = nameText(process.env.CAP_ADMIN_OIDC_SUBJECT, 255);
  if (!email && !password && !oidcSubject) return;
  if (!validEmail(email) || (!oidcSubject && password.length < 12) || (password && password.length < 12) || password.length > 256) {
    throw new Error('Configure CAP_ADMIN_EMAIL e CAP_ADMIN_OIDC_SUBJECT ou senha de 12 a 256 caracteres.');
  }
  db.save('users', { id: 'admin', name: 'Administração IMPARH', email, role: 'admin', active: true, org: 'IMPARH',
    unit: 'Escola de Governo', oidcSubject, passwordHash: password ? passwordHash(password) : undefined });
}

function orgOf(db, row) {
  const record = db.get(row.entity, row.entityId);
  if (!record) return null;
  if (record.org || record.unit) return record;
  const turma = db.get('classes', record.classId) || (row.entity === 'classes' ? record : null);
  const action = db.get('actions', record.actionId || turma?.actionId);
  if (action?.org || action?.unit) return action;
  return null;
}

export function registerAdministration(app) {
  const { db, config, route, sessions } = app;
  route('GET', '/api/administration/users', 'users.write', ctx => {
    globalAdmin(ctx);
    return {
      users: db.list('users').map(person),
      roles: profiles(db),
      capabilities: capabilityNames,
      instructors: db.list('instructors').map(row => pick('instructors', row.id, db)),
      servants: db.list('servants').map(row => pick('servants', row.id, db))
    };
  }, 'Administração de contas, perfis e escopos');
  route('POST', '/api/administration/users', 'users.write', ctx => {
    globalAdmin(ctx);
    const { body, user, audit, fail } = ctx;
    const old = body.id ? db.get('users', body.id) : null;
    if (body.id && !old) fail(404, 'Conta não encontrada.');
    const record = {
      ...old, name: nameText(body.name), email: normalizeEmail(body.email), role: nameText(body.role),
      org: nameText(body.org), unit: nameText(body.unit), scopeOrg: nameText(body.scopeOrg), scopeUnit: nameText(body.scopeUnit),
      oidcSubject: nameText(body.oidcSubject, 255), active: body.active !== false,
      servantId: nameText(body.servantId), instructorId: nameText(body.instructorId)
    };
    if (!record.name || !validEmail(record.email) || !Object.hasOwn(roleNames, record.role)) fail(400, 'Informe o nome, o e-mail e um perfil válido.');
    if (record.role === 'focal' && (!record.org || !record.unit)) fail(400, 'Informe órgão e unidade do ponto focal.');
    if (record.role === 'instructor' && !record.instructorId) fail(400, 'Vincule o perfil ao cadastro de instrutor.');
    if (record.instructorId && !db.get('instructors', record.instructorId)) fail(400, 'Instrutor inválido.');
    if (record.servantId && !db.get('servants', record.servantId)) fail(400, 'Servidor inválido.');
    if (user.id === old?.id && (!record.active || record.role !== 'admin' || record.scopeOrg || record.scopeUnit)) fail(409, 'Mantenha seu acesso de administração geral.');
    const duplicate = db.list('users').find(account => account.id !== old?.id &&
      (normalizeEmail(account.email) === record.email || record.oidcSubject && account.oidcSubject === record.oidcSubject ||
       record.servantId && account.servantId === record.servantId || record.instructorId && account.instructorId === record.instructorId));
    if (duplicate) fail(409, 'O e-mail, a identidade institucional ou o cadastro vinculado já está em uso.');
    if (body.password) {
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) fail(400, 'A senha local deve ter de 12 a 256 caracteres.');
      record.passwordHash = passwordHash(body.password);
    }
    if (body.revokePassword === true) delete record.passwordHash;
    if (record.active && !record.oidcSubject && (!config.allowPassword || !record.passwordHash)) fail(400, 'Vincule uma identidade institucional ou configure uma senha local permitida.');
    return db.tx(() => {
      const saved = db.save('users', record);
      if (old && (old.role !== saved.role || old.active !== saved.active || old.oidcSubject !== saved.oidcSubject ||
          old.scopeOrg !== saved.scopeOrg || old.scopeUnit !== saved.scopeUnit || old.passwordHash !== saved.passwordHash)) {
        sessions.revokeUser(old.id);
      }
      audit(old ? 'account.updated' : 'account.created', 'users', saved.id, { role: saved.role, active: saved.active });
      return person(saved);
    });
  }, 'Cadastra ou altera uma conta');
  route('PUT', '/api/administration/profiles/:id', 'users.write', ctx => {
    globalAdmin(ctx);
    const { params, body, fail, audit } = ctx;
    if (!Object.hasOwn(roleNames, params.id) || !Array.isArray(body.permissions)) fail(400, 'Informe um perfil e suas permissões.');
    const permissions = [...new Set(body.permissions)];
    if (permissions.some(item => !Object.hasOwn(capabilityNames, item))) fail(400, 'Há permissões desconhecidas.');
    if (params.id !== 'admin' && permissions.some(item => ['users.write', 'settings.write', 'data.export', 'integrations.write'].includes(item))) {
      fail(400, 'Permissões administrativas são exclusivas do perfil Administrador.');
    }
    if (params.id === 'auditor' && permissions.some(item => /\.(write|review)$/.test(item))) {
      fail(400, 'O perfil de auditoria é somente de leitura.');
    }
    return db.tx(() => {
      const previous = db.get('profiles', params.id)?.permissions ?? profiles(db).find(item => item.id === params.id).permissions;
      const saved = db.save('profiles', { id: params.id, permissions: params.id === 'admin' ? [...new Set([...permissions, 'users.write'])] : permissions });
      audit('profile.updated', 'profiles', saved.id, { before: previous, after: saved.permissions });
      return saved;
    });
  }, 'Configura permissões de um perfil');
  route('GET', '/api/administration/audit', 'audit.read', ({ user, query }) => {
    const filters = db.list('audit').filter(row => {
      if (user.scopeOrg || user.scopeUnit) {
        const source = orgOf(db, row);
        if (!source || user.scopeOrg && source.org !== user.scopeOrg || user.scopeUnit && source.unit !== user.scopeUnit) return false;
      }
      return (!query.entity || row.entity === query.entity) && (!query.from || row.at >= query.from) &&
        (!query.to || row.at.slice(0, 10) <= query.to) && (!query.actor || row.actorName.toLowerCase().includes(query.actor.toLowerCase()));
    }).reverse();
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    return { total: filters.length, offset, rows: filters.slice(offset, offset + 100) };
  }, 'Consulta paginada à trilha de auditoria');
  route('GET', '/api/administration/settings', 'settings.write', ctx => {
    globalAdmin(ctx);
    return { settings: db.get('settings', 'general') ?? { institution: 'IMPARH · Escola de Governo', annualTarget: 0, planYear: new Date().getFullYear(), support: '' },
      environment: config.env, demo: config.demo, backupHours: config.backupHours, backupCopies: config.backupCopies, lastBackup: lastBackup(config) };
  }, 'Consulta parâmetros e estado do backup');
  route('PUT', '/api/administration/settings', 'settings.write', ctx => {
    globalAdmin(ctx);
    const { body, audit, fail } = ctx;
    const settings = {
      id: 'general', institution: nameText(body.institution), support: nameText(body.support, 500),
      annualTarget: Number(body.annualTarget), planYear: Number(body.planYear)
    };
    if (!settings.institution || !Number.isInteger(settings.annualTarget) || settings.annualTarget < 0 ||
        !Number.isInteger(settings.planYear) || settings.planYear < 2000 || settings.planYear > 2100) fail(400, 'Informe instituição, ano e meta de ações válidos.');
    return db.tx(() => {
      const saved = db.save('settings', settings);
      audit('settings.updated', 'settings', saved.id);
      return saved;
    });
  }, 'Edita os parâmetros gerais e a meta do plano anual');
  route('GET', '/api/support', null, () => ({ contact: db.get('settings', 'general')?.support || '' }), 'Canal de suporte configurado');
  route('POST', '/api/administration/backup', 'settings.write', async ctx => {
    globalAdmin(ctx);
    const file = await backupDatabase(db, config);
    ctx.audit('backup.created', 'settings', 'general', { file: file.split(/[\\/]/).at(-1) });
    return { lastBackup: lastBackup(config) };
  }, 'Gera cópia consistente e verifica a integridade');
  route('GET', '/api/administration/export', 'data.export', ctx => {
    globalAdmin(ctx);
    const omit = new Set(['sessions', 'oidcAttempts', 'oidcStates', 'integrationSettings']);
    const entities = {};
    for (const type of db.types()) {
      if (omit.has(type)) continue;
      entities[type] = db.list(type).map(item => {
        if (type !== 'users') return item;
        const { passwordHash: ignored, ...portable } = item;
        return portable;
      });
    }
    ctx.audit('data.exported', 'settings', 'general', { entities: Object.keys(entities).length });
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="capacitacoes-dados.json"' });
    ctx.res.end(JSON.stringify({ schema: 1, createdAt: ctx.now(), entities }, null, 2));
  }, 'Exporta dados institucionais em JSON para portabilidade');
}
