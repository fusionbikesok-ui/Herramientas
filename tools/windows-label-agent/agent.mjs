import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = process.argv.indexOf('--config');
const configPath = arg >= 0 ? process.argv[arg + 1] : './config.json';
const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
if (!cfg.apiBase || !cfg.agentId || !cfg.printCommand) throw new Error('apiBase, agentId y printCommand son obligatorios');
const api = cfg.apiBase.replace(/\/$/, '');
const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));

async function jsonFetch(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function ejecutarComando(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.printCommand, [inputPath], { shell: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`driver terminó con código ${code}`)));
  });
}

async function unaVez() {
  const claim = await jsonFetch(`${api}/cola/reclamar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agente_id: cfg.agentId }),
  });
  if (!claim.trabajo) return false;
  const trabajo = claim.trabajo;
  const archivo = path.join(os.tmpdir(), `fusionbikes-label-${trabajo.id}-${Date.now()}.json`);
  await fs.writeFile(archivo, JSON.stringify(trabajo), 'utf8');
  try {
    await ejecutarComando(archivo);
    await jsonFetch(`${api}/cola/${trabajo.id}/resultado`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_token: trabajo.claim_token, ok: true }),
    });
  } catch (error) {
    await jsonFetch(`${api}/cola/${trabajo.id}/resultado`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_token: trabajo.claim_token, ok: false, error: error.message }),
    }).catch(() => {});
  } finally { await fs.rm(archivo, { force: true }); }
  return true;
}

while (true) {
  try { await unaVez(); } catch (error) { console.error(`[label-agent] ${error.message}`); }
  await pausa(Number(cfg.pollMs) || 2000);
}
