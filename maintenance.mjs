import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';

const namePattern = /^capacitacoes-\d{4}-\d{2}-\d{2}T[0-9Z.-]+(?:-[a-f0-9]{8})?\.sqlite$/;

export async function backupDatabase(db, config) {
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const name = 'capacitacoes-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.sqlite';
  const destination = resolve(config.backupDir, name);
  const temp = destination + '.tmp';
  try {
    await db.backup(temp);
    verifyBackup(temp);
    chmodSync(temp, 0o600);
    renameSync(temp, destination);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  const copies = readdirSync(config.backupDir).filter(name => namePattern.test(name)).sort().reverse();
  for (const old of copies.slice(config.backupCopies)) unlinkSync(resolve(config.backupDir, old));
  return destination;
}

export function verifyBackup(filename) {
  const check = new DatabaseSync(filename, { readOnly: true });
  try {
    if (check.prepare('PRAGMA user_version').get().user_version !== 1 ||
        !check.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok') ||
        !check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'").get()) {
      throw new Error('O arquivo não é uma cópia íntegra do banco deste sistema.');
    }
  } finally {
    check.close();
  }
}

export function lastBackup(config) {
  if (!existsSync(config.backupDir)) return null;
  const file = readdirSync(config.backupDir).filter(name => namePattern.test(name)).sort().at(-1);
  return file ? statSync(resolve(config.backupDir, file)).mtime.toISOString() : null;
}

async function main() {
  const [action, filename] = process.argv.slice(2);
  const config = readConfig();
  if (action === 'backup') {
    if (!existsSync(config.database)) throw new Error('Banco de origem não encontrado.');
    const db = openStore(config.database);
    try { console.log(await backupDatabase(db, config)); } finally { db.close(); }
    return;
  }
  if (action === 'verify' && filename) {
    verifyBackup(resolve(filename));
    console.log('Cópia íntegra: ' + basename(filename));
    return;
  }
  if (action === 'restore' && filename) {
    const source = resolve(filename);
    verifyBackup(source);
    if (existsSync(config.database) || existsSync(config.database + '-wal') || existsSync(config.database + '-shm')) {
      throw new Error('Selecione um CAP_DATA_DIR vazio para preservar o banco em uso.');
    }
    mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    const temporary = config.database + '.' + randomUUID() + '.tmp';
    const sqlite = new DatabaseSync(source, { readOnly: true });
    try {
      const { backup } = await import('node:sqlite');
      await backup(sqlite, temporary);
      verifyBackup(temporary);
      chmodSync(temporary, 0o600);
      renameSync(temporary, config.database);
    } finally {
      sqlite.close();
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    const db = openStore(config.database);
    try { db.expireSessions(Number.MAX_SAFE_INTEGER); } finally { db.close(); }
    console.log('Banco restaurado: ' + config.database);
    return;
  }
  throw new Error('Use node maintenance.mjs backup | verify ARQUIVO | restore ARQUIVO');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
