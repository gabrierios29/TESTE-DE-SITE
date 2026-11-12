import { resolve } from 'node:path';
import { homedir } from 'node:os';

const numeric = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(name + ' deve estar entre ' + min + ' e ' + max + '.');
  return value;
};

export function readConfig(overrides = {}) {
  const env = overrides.env ?? process.env.CAP_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(env)) throw new Error('CAP_ENV deve ser development, test ou production.');
  const demo = overrides.demo ?? process.env.CAP_DEMO === '1';
  if (demo && env === 'production') throw new Error('Dados de demonstração exigem um ambiente de teste ou desenvolvimento.');
  const port = overrides.port ?? numeric(demo ? 'CAP_DEMO_PORT' : 'CAP_PORT', 4173, 1, 65535);
  const host = overrides.host ?? (demo ? '127.0.0.1' : process.env.CAP_HOST ?? '127.0.0.1');
  const baseUrl = new URL(overrides.baseUrl ?? (demo ? undefined : process.env.CAP_BASE_URL) ?? 'http://127.0.0.1:' + port);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) {
    throw new Error('CAP_BASE_URL deve ser a origem pública do sistema, sem caminho ou credenciais.');
  }
  const secureCookies = baseUrl.protocol === 'https:';
  const tlsKey = demo ? undefined : process.env.CAP_TLS_KEY;
  const tlsCert = demo ? undefined : process.env.CAP_TLS_CERT;
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('Configure CAP_TLS_KEY e CAP_TLS_CERT juntos.');
  if (env === 'production' && (!secureCookies || (!tlsKey && process.env.CAP_TLS_PROXY !== '1'))) {
    throw new Error('Produção requer origem HTTPS e TLS direto ou CAP_TLS_PROXY=1.');
  }
  if (env === 'production' && !tlsKey && !['127.0.0.1', '::1'].includes(host)) {
    throw new Error('O servidor com proxy TLS deve escutar apenas no endereço de loopback.');
  }
  if (demo && !['127.0.0.1', '::1'].includes(host)) throw new Error('A demonstração deve escutar apenas no computador local.');
  const localData = process.env.LOCALAPPDATA ?? homedir();
  const directory = resolve(overrides.directory ?? (demo ? process.env.CAP_DEMO_DATA_DIR : process.env.CAP_DATA_DIR) ?? (demo
    ? resolve(localData, 'IMPARH', 'GestaoCapacitacoes', 'demo')
    : resolve('data', env)));
  if (env === 'production' && !process.env.CAP_DATA_DIR && !overrides.directory) throw new Error('Configure o diretório de dados de produção em CAP_DATA_DIR.');
  return {
    env, demo, host, port, baseUrl: baseUrl.origin, secureCookies, tlsKey, tlsCert, directory,
    database: overrides.database ?? resolve(directory, 'capacitacoes.sqlite'),
    allowPassword: env !== 'production' || process.env.CAP_LOCAL_LOGIN === '1',
    sessionMinutes: numeric('CAP_SESSION_MINUTES', 480, 5, 1440),
    idleMinutes: numeric('CAP_SESSION_IDLE_MINUTES', 60, 5, 1440),
    backupHours: numeric('CAP_BACKUP_HOURS', 24, 1, 168),
    backupCopies: numeric('CAP_BACKUP_COPIES', 14, 2, 365),
    backupDir: resolve((demo ? undefined : process.env.CAP_BACKUP_DIR) ?? resolve(directory, 'backups'))
  };
}
