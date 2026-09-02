#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controller = path.join(root, 'scripts', 'orchestrate-claude.mjs');
let server;
let tempDir;
let dbCopy;
let logFile;
let logStream;

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function usage() {
  console.log(`Uso:
  npm run agent:e2e -- --task-file /tmp/codex-to-claude-task.md [opciones]

Opciones:
  --task-file <archivo>      Tarea base, con Tarea, Rama y Worktree.
  --handoff-file <archivo>  Salida (default: /tmp/claude-to-codex-handoff.json).
  --port <puerto>            Puerto aislado (default: 3199).
  --empty-db                 Usar una base SQLite temporal vacía.
  --playwright-session <id>  Sesión Playwright (default: entrega2e2e).
  --permission-mode <modo>   Permisos Claude (default: acceptEdits; la tarea prohíbe editar).
  --help                     Mostrar esta ayuda.`);
}

function field(text, label) {
  return text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || '';
}

function git(command, cwd) {
  const result = spawnSync('git', command, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${command.join(' ')} falló`);
  return result.stdout.trim();
}

function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => { request.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) return reject(new Error(`servidor aislado no respondió en ${url}`));
      setTimeout(check, 250);
    };
    check();
  });
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      probe.close();
      reject(new Error(`--port ${port} ya está ocupado; no se reutiliza una instancia ajena`));
    });
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function cleanup() {
  if (server?.pid) server.kill('SIGTERM');
  server?.stdout?.destroy();
  server?.stderr?.destroy();
  logStream?.destroy();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

function logTail() {
  if (!logFile || !fs.existsSync(logFile)) return '';
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  return lines.slice(-12).join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) return usage();
  const taskFile = argValue(argv, '--task-file');
  if (!taskFile || !fs.existsSync(taskFile)) throw new Error('--task-file inexistente');
  const handoffFile = argValue(argv, '--handoff-file', '/tmp/claude-to-codex-handoff.json');
  const port = Number(argValue(argv, '--port', '3199'));
  const emptyDb = argv.includes('--empty-db');
  const playwrightSession = argValue(argv, '--playwright-session', 'entrega2e2e');
  const permissionMode = argValue(argv, '--permission-mode', 'acceptEdits');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port inválido');
  if (!['dontAsk', 'plan', 'acceptEdits'].includes(permissionMode)) throw new Error('--permission-mode inválido');
  await assertPortFree(port);

  const task = fs.readFileSync(taskFile, 'utf8');
  const worktree = field(task, 'Worktree');
  if (!worktree || !path.isAbsolute(worktree) || !fs.existsSync(worktree)) throw new Error('Worktree absoluto e inexistente');
  const sourceDb = path.join(root, 'data', 'fusion.sqlite');
  if (!emptyDb && !fs.existsSync(sourceDb)) throw new Error('no existe la base fuente');
  const suffix = `${process.pid}-${Date.now()}`;
  tempDir = path.join('/tmp', `fusion-claude-e2e-${suffix}`);
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  dbCopy = path.join(tempDir, 'fusion.sqlite');
  logFile = path.join(tempDir, 'server.log');
  if (emptyDb) fs.closeSync(fs.openSync(dbCopy, 'w', 0o600));
  else fs.copyFileSync(sourceDb, dbCopy);
  const db = new Database(dbCopy);
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ml_oauth_token'").get()) {
    db.prepare('DELETE FROM ml_oauth_token').run();
  }
  db.close();

  const head = git(['rev-parse', 'HEAD'], worktree);
  const base = git(['rev-parse', 'HEAD^'], worktree);
  const env = {
    ...process.env,
    DB_PATH: dbCopy,
    DISABLE_CRONS: 'true',
    PORT: String(port),
    SESSION_SECRET: `claude-e2e-${suffix}`,
    DOTENV_CONFIG_PATH: '/dev/null',
    WOO_URL: '', WOO_CK: '', WOO_CS: '', GEMINI_KEY: '',
    ML_CLIENT_ID: '', ML_CLIENT_SECRET: '', ML_USER_ID: '',
  };
  server = spawn('node', ['server.js'], { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
  logStream = fs.createWriteStream(logFile, { mode: 0o600 });
  server.stdout.pipe(logStream);
  server.stderr.pipe(logStream);
  await waitForHttp(`http://127.0.0.1:${port}/login/`, 15_000);

  const enrichedTask = `${task.trim()}\n\nEntorno: local-aislado\nURL exacta: http://127.0.0.1:${port}/login/\nRama/worktree servido: ${worktree}\nHEAD/base: ${head} / ${base}\nDB temporal: ${dbCopy}\nDISABLE_CRONS=true: sí\nPuerto: ${port}\nSesión Playwright: ${playwrightSession}\nDirectorio de artefactos: ${path.join(root, 'output', 'playwright')}\nPID/sesión del servidor: ${server.pid}\nAcciones autorizadas: solo lectura y datos de prueba aislados\n`;
  const enrichedFile = `/tmp/codex-to-claude-e2e-${suffix}.md`;
  fs.writeFileSync(enrichedFile, `${enrichedTask}\n`, { mode: 0o600 });

  const child = spawn(process.execPath, [controller, '--role', 'probador-e2e', '--task-file', enrichedFile, '--handoff-file', handoffFile, '--permission-mode', permissionMode], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode));
  });
  fs.rmSync(enrichedFile, { force: true });
  cleanup();
  if (code !== 0) throw new Error(`el controlador Claude terminó con código ${code}`);
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main().catch((error) => {
  const tail = logTail();
  console.error(`E2E aislado fallido: ${error.message}${tail ? `\nÚltimas líneas del servidor:\n${tail}` : ''}`);
  cleanup();
  process.exitCode = 1;
});
