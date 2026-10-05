#!/usr/bin/env node
/* WorkFlowGraph 伺服器控制：npm run stop / npm run restart
   原理：server.js 啟動時會把自己的 PID 寫進 server.pid，
   這支腳本讀取後結束該程序（可跨終端機視窗操作）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT, 'server.pid');
const LOG_FILE = path.join(ROOT, 'server.log');
const cmd = process.argv[2];

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function stop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('找不到 server.pid — 伺服器應該沒有在執行。');
    return false;
  }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (!pid || !alive(pid)) {
    console.log('伺服器沒有在執行（清除過期的 server.pid）。');
    try { fs.unlinkSync(PID_FILE); } catch {}
    return false;
  }
  process.kill(pid);                       // Windows 上等同終止該程序
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  if (alive(pid)) { console.error(`✗ 無法結束程序 ${pid}，請手動處理。`); process.exit(1); }
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(`✓ 伺服器已停止（PID ${pid}）。`);
  return true;
}

function startBackground() {
  const fd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  console.log(`✓ 伺服器已在背景啟動（PID ${child.pid}）→ http://localhost:${process.env.PORT || 3000}`);
  console.log(`  日誌：${LOG_FILE}`);
}

(async () => {
  if (cmd === 'stop') {
    await stop();
  } else if (cmd === 'restart') {
    await stop();
    await sleep(300);                      // 等埠釋放
    startBackground();
  } else {
    console.log('用法：node scripts/ctl.js stop|restart');
    process.exit(1);
  }
})();
