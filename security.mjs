import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const roleNames = {
  admin: 'Administrador', manager: 'Gestor da Escola', tech: 'Equipe técnica',
  focal: 'Ponto focal', instructor: 'Instrutor', participant: 'Servidor', auditor: 'Consulta e auditoria'
};
export const capabilityNames = {
  'requests.read': 'Consultar solicitações', 'requests.write': 'Registrar solicitações', 'requests.review': 'Analisar solicitações',
  'actions.read': 'Consultar ações, turmas e calendário', 'actions.write': 'Gerenciar ações e turmas',
  'instructors.read': 'Consultar instrutores', 'instructors.write': 'Gerenciar instrutores',
  'registrations.read': 'Consultar inscrições', 'registrations.write': 'Registrar inscrições', 'registrations.review': 'Gerenciar inscrições',
  'attendance.read': 'Consultar frequência', 'attendance.write': 'Lançar frequência',
  'history.read': 'Consultar histórico formativo', 'evaluations.read': 'Acessar avaliações', 'evaluations.write': 'Gerenciar avaliações',
  'certificates.read': 'Consultar certificados', 'certificates.write': 'Emitir e invalidar certificados',
  'reports.read': 'Acessar relatórios gerenciais', 'integrations.read': 'Consultar integrações',
  'integrations.write': 'Gerenciar integrações', 'users.write': 'Gerenciar usuários e permissões',
  'audit.read': 'Consultar trilha de auditoria', 'settings.write': 'Configurar parâmetros', 'data.export': 'Exportar dados da base'
};
const schoolRead = ['requests.read', 'actions.read', 'instructors.read', 'registrations.read', 'attendance.read', 'evaluations.read', 'certificates.read', 'reports.read'];
const profileDefaults = {
  admin: Object.keys(capabilityNames),
  manager: [...schoolRead, 'integrations.read', 'audit.read'],
  tech: [...schoolRead, 'requests.write', 'requests.review', 'actions.write', 'instructors.write', 'registrations.write', 'registrations.review', 'attendance.write', 'evaluations.write', 'certificates.write', 'integrations.read'],
  focal: ['requests.read', 'requests.write'],
  instructor: ['actions.read', 'attendance.read'],
  participant: ['actions.read', 'registrations.read', 'registrations.write', 'history.read', 'evaluations.read', 'certificates.read'],
  auditor: [...schoolRead, 'audit.read']
};
const fixedAdmin = ['users.write'];
const digest = (token) => createHash('sha256').update(token).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

export function effectivePermissions(db, user) {
  const base = db.get('profiles', user.role)?.permissions ?? profileDefaults[user.role] ?? [];
  const permissions = new Set(base);
  for (const [name, enabled] of Object.entries(user.overrides ?? {})) {
    if (enabled) permissions.add(name);
    else permissions.delete(name);
  }
  if (user.role === 'admin' && !user.scopeOrg && !user.scopeUnit) for (const name of fixedAdmin) permissions.add(name);
  return [...permissions].filter(name => Object.hasOwn(capabilityNames, name));
}

export function publicUser(db, user) {
  const { passwordHash, overrides, ...info } = user;
  return { ...info, permissions: effectivePermissions(db, user) };
}

export function profiles(db) {
  return Object.entries(roleNames).map(([id, name]) => ({
    id, name, permissions: db.get('profiles', id)?.permissions ?? profileDefaults[id]
  }));
}

export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}

const dummy = passwordHash(randomBytes(24).toString('hex'));
export function matchesPassword(password, hash) {
  const [salt, stored] = (hash ?? dummy).split(':');
  const computed = scryptSync(password, salt, 64);
  return timingSafeEqual(computed, Buffer.from(stored, 'hex')) && Boolean(hash);
}

export function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie ?? '').split(';').map(part => {
    const i = part.indexOf('=');
    return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([key]) => key));
}

function appendCookie(res, value) {
  const existing = res.getHeader('set-cookie') ?? [];
  res.setHeader('set-cookie', [existing].flat().concat(value));
}

export function makeSessions(db, options) {
  const name = options.secureCookies ? '__Host-cap_session' : 'cap_session';
  const maxAge = options.sessionMinutes * 60;
  const attributes = '; HttpOnly; SameSite=Lax; Path=/' + (options.secureCookies ? '; Secure' : '');
  return {
    current(req) {
      const raw = cookies(req)[name];
      if (!raw || !/^[\w-]{43}$/.test(raw)) return null;
      const session = db.get('sessions', digest(raw));
      const now = Date.now();
      if (!session || session.expiresAt <= now || session.idleUntil <= now) return null;
      const user = db.get('users', session.userId);
      if (!user || user.active === false) return null;
      if (session.idleUntil - now < options.idleMinutes * 45_000) {
        db.save('sessions', { ...session, idleUntil: now + options.idleMinutes * 60_000 });
      }
      return publicUser(db, user);
    },
    create(req, res, user) {
      const previous = cookies(req)[name];
      if (previous) db.remove('sessions', digest(previous));
      const raw = token();
      db.save('sessions', { id: digest(raw), userId: user.id,
        expiresAt: Date.now() + maxAge * 1000, idleUntil: Date.now() + options.idleMinutes * 60_000 });
      appendCookie(res, name + '=' + raw + '; Max-Age=' + maxAge + attributes);
      return publicUser(db, user);
    },
    end(req, res) {
      const raw = cookies(req)[name];
      if (raw) db.remove('sessions', digest(raw));
      appendCookie(res, name + '=; Max-Age=0' + attributes);
    },
    revokeUser(userId) {
      for (const session of db.list('sessions')) if (session.userId === userId) db.remove('sessions', session.id);
    }
  };
}
