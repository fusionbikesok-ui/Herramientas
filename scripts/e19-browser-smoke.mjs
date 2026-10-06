#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { hashPassword } from '../lib/auth.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-e19-browser-'));
const dbPath = path.join(temp, 'fusion.sqlite');
const port = 4200 + (process.pid % 100); let server;
const waitFor = url => new Promise((resolve, reject) => { const started = Date.now(); const poll = () => { const req = http.get(url, res => { res.resume(); if (res.statusCode < 500) resolve(); else retry(); }); req.on('error', retry); req.setTimeout(1000, () => { req.destroy(); retry(); }); function retry(){ if(Date.now()-started>15000)reject(Error(`server timeout: ${url}`)); else setTimeout(poll,100); } }; poll(); });
async function main(){
  server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DB_PATH:dbPath,PORT:String(port),DISABLE_CRONS:'true',DOTENV_CONFIG_PATH:'/dev/null',SESSION_SECRET:'e19-session',MOBILE_JWT_SECRET:'e19-browser-mobile-secret-0123456789'},stdio:'inherit'});
  await waitFor(`http://127.0.0.1:${port}/login/`);
  const db=new Database(dbPath),ts=new Date().toISOString();db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,?,?,?,?)').run('e19-browser-admin',hashPassword('E19-browser-only-123!'),1,1,ts,ts);db.close();
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1440,height:900}});
  try{await page.goto(`http://127.0.0.1:${port}/login/`,{waitUntil:'domcontentloaded'});await page.locator('#user').fill('e19-browser-admin');await page.locator('#pass').fill('E19-browser-only-123!');await page.locator('#btn').click();await page.waitForURL(/herramientas\/home/);await page.goto(`http://127.0.0.1:${port}/garantias/`,{waitUntil:'domcontentloaded'});const result=await page.evaluate(async()=>{const r=await fetch('/api/warranties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pedido_id:'E19-E2E',sku:'FB-E19',motivo:'Prueba aislada',responsable:'ventas',operation_id:'e19-browser-case'})});if(r.status!==201)throw Error(`alta ${r.status}`);return {status:r.status}});await page.reload({waitUntil:'networkidle'});if(!await page.getByText('E19-E2E').isVisible())throw Error('caso no renderizado');console.log(`E19 browser: bandeja y alta aislada OK (${result.status})`)}finally{await page.close();await browser.close()}}
try{await main()}finally{if(server?.pid)server.kill('SIGTERM');fs.rmSync(temp,{recursive:true,force:true})}
