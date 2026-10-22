#!/usr/bin/env node
/* =====================================================
   WorkFlowGraph 本地伺服器
   - 提供 public/ 靜態檔案（畫布 UI）
   - POST /api/llm    → 呼叫本機已登入的 Claude Code（claude -p）
   - POST /api/shell  → 在本機執行 shell 指令（前端有總開關與逐段確認；只聽 loopback）
   - GET  /api/health → 偵測本機 claude 是否可用
   零外部依賴：只用 Node.js 內建模組，不需 npm install。
   啟動：node server.js   （或 npm start）
   ===================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
/* 只聽 loopback。這台伺服器有 /api/shell（執行任意指令）、/api/writefile、/api/readfile，
   綁 0.0.0.0 等於把「在我機器上跑指令」開放給同一個網段的任何人。
   真的需要對外時自己設 HOST=0.0.0.0，並自負風險。 */
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';

/* ---------- 本機端點的來源把關 ----------
   只聽 loopback 擋得住「同網段的別台機器」，擋不住「使用者瀏覽器裡的惡意頁面對
   localhost 發 POST」——那個請求本來就是從 127.0.0.1 發出的。所以 Shell 的三道閘門
   不能只做在前端，後端自己要擋：

     ① Host 白名單 → 擋 DNS rebinding（攻擊者網域解析到 127.0.0.1 就會變成同源）
     ② Origin（有帶就必須是自己）→ 擋一般的跨源頁面
     ③ POST 一律要求 Content-Type: application/json → 跨源就無法用「簡單請求」偷跑。
        簡單請求（text/plain 等）不觸發 preflight，是 CSRF 打 localhost 的主要路徑，
        而我們不回任何 CORS 標頭，所以只要逼出 preflight 就一定失敗。
     ④ /api/shell 另外要求 x-wfg-token：自訂標頭必定觸發 preflight（同樣必定失敗），
        權杖本身每次啟動重產、不可猜，也不落地。 */
const API_TOKEN = crypto.randomBytes(24).toString('hex');
const LOOPBACK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const LOOPBACK_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
function guardApi(req) {
  const host = String(req.headers.host || '');
  // HOST 被自己改成對外時不套 Host 白名單（使用者已明確自負風險），其餘檢查照做
  if ((HOST === '127.0.0.1' || HOST === 'localhost') && !LOOPBACK_HOSTS.has(host))
    return `不接受的 Host：${host || '(空)'}`;
  const origin = req.headers.origin;
  if (origin && !LOOPBACK_ORIGINS.has(origin)) return `不接受的 Origin：${origin}`;
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return `POST 必須是 application/json（收到 ${ct || '(空)'}）`;
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* ---------- 命令列安全 ----------
   Windows 上 npm 全域安裝的是 `claude.cmd`，Node 18 之後不允許不帶 shell 執行 .cmd，
   所以 ENOENT 時必須 `shell:true` 重試——而 `spawn(cmd, args, {shell:true})` 的 args
   **完全不會被跳脫**：Node 只是用空白把它們串成一行命令字串丟給 cmd.exe。
   因此規則是：

     ① 可變內容（system 提示）永遠不進 argv，只走 --system-prompt-file 的暫存檔
     ② 進 argv 的只有：旗標、白名單過的模型名、我們自己產生的暫存檔路徑
     ③ 走 shell 時每個參數都自己加引號（Node 不會幫）

   引號能擋空白與 & | ^ ( ) < >；`"` 和 `%` 沒有可靠的包法（`%VAR%` 在雙引號內仍會展開），
   所以暫存檔會挑一個「路徑不含這兩個字元」的目錄，挑不到就寧可報錯，也不拼命令列。 */
const WIN_UNSAFE_PATH = /["%]/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;   // 模型名來自前端，可能來自匯入的 JSON

function shellQuoteArg(a) {
  const s = String(a);
  return IS_WIN ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

/* system 提示寫進暫存檔。0600 + 'wx'：不跟隨既有檔案／symlink，也不讓同機其他使用者讀。
   檔名用 crypto 亂數而不是 Math.random()。依序試多個目錄，回傳可安全進命令列的路徑。 */
function writeSysPromptFile(text, prefix = 'wfg-sys', ext = 'txt') {
  const dirs = [];
  if (process.env.WFG_TMP) dirs.push(process.env.WFG_TMP);
  dirs.push(os.tmpdir());
  if (IS_WIN && process.env.SystemRoot) dirs.push(path.join(process.env.SystemRoot, 'Temp'));
  dirs.push(path.join(__dirname, '.tmp'));
  for (const dir of dirs) {
    if (IS_WIN && WIN_UNSAFE_PATH.test(dir)) continue;      // 這個目錄沒法安全地進命令列
    for (let i = 0; i < 3; i++) {
      const f = path.join(dir, `${prefix}-${process.pid}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(f, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return f;
      } catch (e) { if (e.code !== 'EEXIST') break; }        // 同名撞了才重試，其他錯誤換目錄
    }
  }
  return null;
}

/* ---------- 呼叫本機 Claude Code ---------- */
/* 逾時採兩層：
   ① 活動式逾時（idle）：stream-json 模式下，只要子行程持續有輸出活動就不會被砍；
      連續 idleMs 沒有任何輸出才視為卡死。這讓「工作量大但有進度」的呼叫不被誤殺。
   ② 硬上限（timeoutMs）：無論多有進度，超過就中止——防真正的失控。
   舊版 CLI 不支援 stream-json 時自動退回單包 json（此時只有硬上限）。 */
const IDLE_MS_DEFAULT = (() => {
  const v = Number(process.env.WFG_IDLE_MS);
  return Number.isFinite(v) && v >= 15000 ? v : 180000;   // 預設 180s 無活動＝卡死
})();
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;      // resume 的 session id（uuid 形狀）

/* 進度追蹤器：把 stream 事件濃縮成人看的進度行（CLI 與 SDK 後端共用）。
   不逐筆轉發工具呼叫（會灌爆日誌），改為每 15 秒一行摘要。 */
function makeProgressTracker(onProgress) {
  const st = { toolCount: 0, lastTool: '', genChars: 0, sessionId: null, timer: null };
  st.handle = j => {
    if (j.type === 'system' && j.subtype === 'init') { if (j.session_id) st.sessionId = j.session_id; }
    else if (j.type === 'assistant' && j.message?.content) {
      for (const b of j.message.content) {
        if (b.type !== 'tool_use') continue;
        st.toolCount++;
        const inp = b.input || {};
        const arg = String(inp.file_path || inp.pattern || inp.path || inp.query || '');
        st.lastTool = b.name + (arg ? ' ' + (arg.length > 48 ? '…' + arg.slice(-48) : arg) : '');
      }
    } else if (j.type === 'stream_event') {
      const d = j.event?.delta;
      if (d && typeof d.text === 'string') st.genChars += d.text.length;
    } else if (j.type === 'result') {
      if (j.session_id) st.sessionId = j.session_id;
    }
  };
  if (onProgress) {
    const started = Date.now();
    st.timer = setInterval(() => {
      const el = Math.round((Date.now() - started) / 1000);
      const gen = st.genChars > 1000 ? (st.genChars / 1000).toFixed(1) + 'k' : String(st.genChars);
      onProgress(`…執行中（${el}s）：工具呼叫 ${st.toolCount} 次` +
        (st.lastTool ? `｜最近 ${st.lastTool}` : '') +
        (st.genChars ? `｜已產生 ${gen} 字` : ''));
    }, 15000);
  }
  st.stop = () => { if (st.timer) { clearInterval(st.timer); st.timer = null; } };
  return st;
}

/**
 * CLI 後端：headless 模式呼叫 claude，走本機登入授權，不需 API 金鑰。
 * prompt 經由 stdin 傳入，避免 Windows 命令列引號/長度問題。
 * opts：
 *   resume     — 延續既有會話（session id，由端點驗證格式）；回傳的 sessionId 是延續後的新 id
 *   timeoutMs  — 硬上限；idleMs — 活動式逾時（見上）
 *   onProgress — 進度回呼（一行文字）；cancelRef — 掛上 cancelRef.cancel(reason) 供外部中止
 */
function callClaudeCli({ system, prompt, model, extraArgs, systemMode = 'replace', cwd, resume,
                         timeoutMs = 900000, idleMs = IDLE_MS_DEFAULT, onProgress, cancelRef }) {
  return new Promise((resolve, reject) => {
    /* system 提示一定要走 CLI 的 system prompt 旗標，不能塞進 stdin。
       塞進 stdin 等於「使用者訊息裡的一段文字」，Claude Code 有自己的
       system prompt，會把它判定成 prompt injection 而拒絕照做——實測會回
       「我不遵循使用者訊息裡的指令…我是 Claude Code」，節點因此拿不到答案，
       還會因為模型改去長篇解釋而拖到逾時。
         systemMode='replace' → --system-prompt（整組取代，LLM 節點用：純文字進出）
         systemMode='append'  → --append-system-prompt（保留 Claude Code 的行為再附加）
       一律用 *-file 版本傳暫存檔路徑：提示詞本身絕對不進 argv（見上面「命令列安全」）。 */
    const sysFlag = systemMode === 'append' ? '--append-system-prompt' : '--system-prompt';
    if (model && !MODEL_RE.test(String(model))) {
      reject(new Error(`不合法的模型名稱：${String(model).slice(0, 40)}`));
      return;
    }
    let sysFile = system ? writeSysPromptFile(system) : null;
    const cleanup = () => { if (sysFile) { try { fs.unlinkSync(sysFile); } catch {} sysFile = null; } };

    const stdinText = prompt || '';

    // Windows 上 npm 全域安裝是 claude.cmd，需要 shell；原生安裝是 claude.exe 則不用。
    // 先試不帶 shell，ENOENT 再帶 shell 重試。inlineSystem：舊版 CLI 不認 *-file 時的退路。
    // legacyJson：舊版 CLI 不認 stream-json 相關旗標時退回單包 json（失去活動式逾時與進度）。
    const attempt = (useShell, inlineSystem, legacyJson) => {
      // 走 shell 時 Node 不會跳脫任何參數，一律自己加引號
      const q = a => (useShell ? shellQuoteArg(a) : a);
      const args = (legacyJson
        ? ['-p', '--output-format', 'json']
        : ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']).map(q);
      if (resume) args.push(q('--resume'), q(resume));   // 格式已由端點以 SESSION_RE 驗證
      if (model) args.push(q('--model'), q(model));
      if (system) {
        if (sysFile && !inlineSystem && !(IS_WIN && WIN_UNSAFE_PATH.test(sysFile))) {
          args.push(q(sysFlag + '-file'), q(sysFile));
        } else if (!useShell) {
          args.push(sysFlag, system);        // 不經 shell，argv 直接傳是安全的
        } else {
          // 唯一無法安全處理的組合：必須走 shell，卻沒有可用的暫存檔路徑。
          // 寧可明確失敗，也不把提示詞拼進命令列（含 & | > 就會變成額外指令）。
          cleanup();
          reject(new Error('無法安全傳遞 System 提示：找不到可用的暫存目錄。' +
            '請設定 WFG_TMP 到一個路徑不含 " 與 % 的資料夾，或改用 Claude Code 原生安裝版。'));
          return;
        }
      }
      if (extraArgs) args.push(...extraArgs.map(q));
      const child = spawn('claude', args, {
        shell: useShell,
        windowsHide: true,
        env: { ...process.env },
        /* cwd＝Claude Code 的工作區邊界：headless 模式下，啟動目錄之外的檔案
           存取會被它自己的權限系統擋下。程式碼查詢節點靠這個把唯讀範圍
           錨定在使用者指定的專案根目錄（機制保證，不靠提示詞）。 */
        ...(cwd ? { cwd } : {}),
      });
      let out = '', err = '', lineBuf = '', done = false, finalObj = null;
      const tracker = makeProgressTracker(legacyJson ? null : onProgress);
      const started = Date.now();
      let lastActivity = started;

      /* 兩種收尾：settle＝定案（清計時器＋刪暫存檔＋敲定 Promise）；
         handoff＝交棒給下一個 attempt（只清本 attempt 的計時器，暫存檔留給重試用）。 */
      const settle = (fn, v) => { if (done) return; done = true; clearInterval(watchdog); tracker.stop(); cleanup(); fn(v); };
      const handoff = next => { if (done) return; done = true; clearInterval(watchdog); tracker.stop(); next(); };
      const kill = () => { try { child.kill(); } catch {} };
      if (cancelRef) cancelRef.cancel = reason => { kill(); settle(reject, new Error(reason || '已中斷')); };

      const watchdog = setInterval(() => {
        if (done) return;
        const now = Date.now();
        if (now - started > timeoutMs) {
          kill();
          settle(reject, new Error(`本地 Claude 執行超過硬上限（${Math.round(timeoutMs / 1000)}s）。` +
            '若這是正常的大工作量，調高節點的「逾時上限」參數。'));
        } else if (!legacyJson && now - lastActivity > idleMs) {
          kill();
          settle(reject, new Error(`本地 Claude 已 ${Math.round(idleMs / 1000)}s 沒有任何輸出活動，視為卡死中止` +
            `（活動式逾時；只要持續有進度就不會觸發，硬上限 ${Math.round(timeoutMs / 1000)}s）`));
        }
      }, 2000);

      /* stdout／stderr 一律先 setEncoding('utf8')：不設的話 'data' 收到的是 Buffer，
         `out += d` 等於「逐個 chunk 各自 toString()」——一個多位元組字元剛好跨在
         64KB 的 chunk 邊界上就會被拆成兩半、變成兩個 U+FFFD。輸出超過一個 chunk
         又含中文時才會發作，所以症狀是「偶爾有一個字壞掉」。setEncoding 會掛上
         StringDecoder，跨 chunk 的位元組由它保留到下一塊，'data' 直接給正確的字串。 */
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => {
        lastActivity = Date.now();
        if (legacyJson) { out += d; return; }
        lineBuf += d;
        let i;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i).trim();
          lineBuf = lineBuf.slice(i + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }   // 非 JSON 行（例如警告）忽略
          tracker.handle(j);
          if (j.type === 'result') finalObj = j;
        }
      });
      child.stderr.on('data', d => { lastActivity = Date.now(); err += d; });
      child.on('error', e => {
        if (done) return;
        /* 交棒給重試前先關掉這個 attempt：spawn 失敗時 Node 在 error 之後還會再發一次
           close，不設 done 的話舊 attempt 的 close handler 會跑，把重試中的子行程正在用的
           暫存檔 cleanup() 掉，還會搶先 reject 外層 Promise。 */
        if (e.code === 'ENOENT' && !useShell) { handoff(() => attempt(true, inlineSystem, legacyJson)); return; }
        settle(reject, new Error('找不到 claude 指令。請先安裝並登入 Claude Code：https://claude.com/claude-code'));
      });
      child.on('close', code => {
        if (done) return;
        if (code !== 0) {
          const msg = err || out || lineBuf;
          const unknownFlag = /unknown option|unknown argument|unrecognized/i.test(msg);
          /* 退路①：舊版 CLI 不認 stream-json / --include-partial-messages → 退回單包 json。 */
          if (!legacyJson && unknownFlag) { handoff(() => attempt(useShell, inlineSystem, true)); return; }
          /* 退路②：舊版 CLI 不認 --system-prompt-file → 改用同名的行內旗標再試一次。
             但只在**不經 shell** 時這麼做：走 shell 的話行內旗標等於把提示詞
             拼進 cmd.exe 的命令列，含 & | ^ > 就會變成額外指令。 */
          if (system && sysFile && !inlineSystem && unknownFlag) {
            if (!useShell) { handoff(() => attempt(useShell, true, legacyJson)); return; }
            settle(reject, new Error('這個版本的 Claude Code 不支援 --system-prompt-file，' +
              '而目前必須透過 shell 執行（Windows 的 claude.cmd）——把提示詞放進命令列並不安全。' +
              '請升級 Claude Code，或改用原生安裝版。'));
            return;
          }
          settle(reject, new Error(`claude 結束碼 ${code}：${msg.slice(0, 400)}`));
          return;
        }
        if (legacyJson) {
          try {
            const j = JSON.parse(out);
            // --output-format json 的回傳格式：{ result, is_error, total_cost_usd, usage, ... }
            if (j.is_error) settle(reject, new Error(String(j.result).slice(0, 400)));
            else settle(resolve, {
              text: j.result ?? '',
              costUsd: j.total_cost_usd,
              durationMs: j.duration_ms,
              usage: normUsage(j.usage),
              sessionId: j.session_id || null,
            });
          } catch {
            settle(resolve, { text: out.trim() }); // 更舊版 CLI 或純文字輸出的容錯
          }
          return;
        }
        if (!finalObj) {
          settle(reject, new Error('claude 正常結束但沒有回傳 result 事件（stream-json 輸出不完整）'));
          return;
        }
        if (finalObj.is_error) {
          settle(reject, new Error(String(finalObj.result ?? finalObj.error ?? '執行錯誤').slice(0, 400)));
          return;
        }
        settle(resolve, {
          text: finalObj.result ?? '',
          costUsd: finalObj.total_cost_usd,
          durationMs: finalObj.duration_ms,
          usage: normUsage(finalObj.usage),
          sessionId: tracker.sessionId || finalObj.session_id || null,
          numTurns: finalObj.num_turns,
        });
      });

      child.stdin.on('error', () => {});
      child.stdin.end(stdinText, 'utf8');
    };
    // WFG_SPAWN_SHELL=1：直接走 shell 路徑（Windows 回退路徑的疑難排解與自動測試用）
    attempt(process.env.WFG_SPAWN_SHELL === '1', false, false);
  });
}

/* ---------- Agent SDK 後端（第三層，可選） ----------
   啟用條件（兩者皆備，否則一律走 CLI，維持零依賴預設）：
     ① 環境變數 WFG_BACKEND=sdk
     ② 已安裝 @anthropic-ai/claude-agent-sdk（npm i @anthropic-ai/claude-agent-sdk）
   同一個呼叫契約（含會話 resume、活動式逾時、進度回呼），前端與 FlowMap 完全無感。
   附帶差異：SDK 預設不載入 CLAUDE.md／settings（settingSources 空），基底 context 更乾淨。 */
let _sdkQuery, _sdkTried = false;
function getSdkQuery() {
  if (_sdkTried) return _sdkQuery;
  _sdkTried = true;
  _sdkQuery = null;
  if (String(process.env.WFG_BACKEND || '').toLowerCase() !== 'sdk') return null;
  try {
    _sdkQuery = require('@anthropic-ai/claude-agent-sdk').query;
    console.log('[backend] WFG_BACKEND=sdk：使用 Agent SDK 後端');
  } catch (e) {
    console.warn('[backend] WFG_BACKEND=sdk 但載入 @anthropic-ai/claude-agent-sdk 失敗，退回 CLI 後端：' + e.message);
  }
  return _sdkQuery;
}

async function callClaudeSdk({ system, prompt, model, policy, systemMode = 'replace', cwd, resume,
                               timeoutMs = 900000, idleMs = IDLE_MS_DEFAULT, onProgress, cancelRef }) {
  const query = getSdkQuery();
  const ac = new AbortController();
  const tracker = makeProgressTracker(onProgress);
  const started = Date.now();
  let lastActivity = started;
  let timedOutMsg = null;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - started > timeoutMs) {
      timedOutMsg = `本地 Claude 執行超過硬上限（${Math.round(timeoutMs / 1000)}s）。若這是正常的大工作量，調高節點的「逾時上限」參數。`;
      ac.abort();
    } else if (now - lastActivity > idleMs) {
      timedOutMsg = `本地 Claude 已 ${Math.round(idleMs / 1000)}s 沒有任何輸出活動，視為卡死中止（活動式逾時；硬上限 ${Math.round(timeoutMs / 1000)}s）`;
      ac.abort();
    }
  }, 2000);
  if (cancelRef) cancelRef.cancel = reason => { timedOutMsg = reason || '已中斷'; ac.abort(); };
  try {
    if (model && !MODEL_RE.test(String(model))) throw new Error(`不合法的模型名稱：${String(model).slice(0, 40)}`);
    const options = {
      abortController: ac,
      includePartialMessages: true,
      tools: policy?.tools || [],              // 對應 CLI 的 --tools 白名單
      allowedTools: policy?.allowed || [],
      disallowedTools: policy?.disallowed || [],
      mcpServers: policy?.mcpServers || {}, strictMcpConfig: true,   // 對應 --strict-mcp-config（SDK 路徑未實測：本機未安裝 SDK）
      ...(model ? { model } : {}),
      ...(cwd ? { cwd } : {}),
      ...(resume ? { resume } : {}),
      ...(system !== undefined && system !== null
        ? { systemPrompt: systemMode === 'append' ? { type: 'preset', preset: 'claude_code', append: system } : system }
        : {}),
    };
    let finalObj = null;
    for await (const m of query({ prompt: prompt || '', options })) {
      lastActivity = Date.now();
      tracker.handle(m);
      if (m.type === 'result') finalObj = m;
    }
    if (!finalObj) throw new Error('Agent SDK 沒有回傳 result 訊息');
    if (finalObj.is_error) throw new Error(String(finalObj.result ?? finalObj.subtype ?? '執行錯誤').slice(0, 400));
    return {
      text: finalObj.result ?? '',
      costUsd: finalObj.total_cost_usd,
      durationMs: finalObj.duration_ms,
      usage: normUsage(finalObj.usage),
      sessionId: tracker.sessionId || finalObj.session_id || null,
      numTurns: finalObj.num_turns,
    };
  } catch (e) {
    if (timedOutMsg) throw new Error(timedOutMsg);
    throw e;
  } finally {
    clearInterval(watchdog);
    tracker.stop();
  }
}

/* 統一入口：SDK 後端可用就走 SDK，否則 CLI。兩者契約相同。 */
function runClaude(opts) {
  if (getSdkQuery()) return callClaudeSdk(opts);
  const { policy, ...rest } = opts;
  return callClaudeCli({ ...rest, extraArgs: opts.extraArgs || (policy ? policyArgs(policy) : undefined) });
}

/* 把 claude CLI 的 usage 正規化成前端要的形狀。
   欄位缺漏時一律當 0；整包缺席（舊版 CLI）時回 null，前端就不顯示用量。 */
function normUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const fresh = num(u.input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const out = num(u.output_tokens);
  const inTotal = fresh + cacheWrite + cacheRead;
  if (!inTotal && !out) return null;
  return { in: inTotal, out, fresh, cacheWrite, cacheRead };
}

/* 工具政策（CLI 後端轉成旗標、SDK 後端直接吃陣列）。三個欄位：
     tools      — 白名單，第一道：--tools 只開這些內建工具（空陣列 → --tools "" 全關），
                  ToolSearch、Skill、Artifact、Cron… 這些新工具因此根本不存在
     allowed    — 白名單內要自動核准的工具（--allowedTools）
     disallowed — 黑名單，第二道保險（--disallowedTools）；舊版 CLI 不認 --tools 時至少還有它
   另外一律 --strict-mcp-config ＋ 空的 --mcp-config：claude.ai 連接器與外掛的 MCP 工具
   不受 --tools 管，不拔會讓「純文字」節點透過 ToolSearch 摸到 Google Drive 分享／刪檔。
   為什麼不是把 ToolSearch 加進黑名單（2026-10-22 實測，haiku、同一 prompt）：
     舊黑名單                      36.6k 輸入 token，仍看得到連接器與 84 個 skill
     舊黑名單＋ToolSearch           73.5k（延遲載入的工具 schema 全部被迫內嵌，更糟）
     --tools "" ＋空 MCP 設定        3.2k，零工具、零 skill
   模型的工具清單裡沒有 Write/Bash，就不會「想去建檔案」、不會探索目錄、
   也不會回覆「寫入權限未被授予」——這是機制保證，不靠提示詞。 */
const EMPTY_MCP_CONFIG = path.join(__dirname, 'empty-mcp.json');   // 內容固定 {"mcpServers":{}}，進版控
const ALL_TOOLS = 'Bash,Write,Edit,MultiEdit,NotebookEdit,Read,Glob,Grep,LS,WebFetch,WebSearch,Task,TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode'.split(',');
const POLICY = {
  /* 純文字進出：全拔 */
  text: { tools: [], allowed: [], disallowed: ALL_TOOLS },
  /* 網路查詢：只留 WebSearch / WebFetch，其餘照樣拔掉 */
  websearch: {
    tools: ['WebSearch', 'WebFetch'],
    allowed: ['WebSearch', 'WebFetch'],
    disallowed: 'Bash,Write,Edit,MultiEdit,NotebookEdit,Task,TodoWrite,SlashCommand'.split(','),
  },
  /* 程式碼查詢：只留唯讀三件組（Read / Grep / Glob），其餘照樣拔掉。
     範圍限制不在這裡——靠 cwd（Claude Code 的工作區邊界）＋回傳後的引用逐筆驗證
     （見 validateCitations）。沒有 Bash、沒有寫檔、沒有網路。 */
  codequery: {
    tools: ['Read', 'Grep', 'Glob'],
    allowed: ['Read', 'Grep', 'Glob'],
    disallowed: 'Bash,Write,Edit,MultiEdit,NotebookEdit,LS,WebFetch,WebSearch,Task,TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode'.split(','),
  },
};
/* MCP 代理的伺服器設定驗證：名稱會進 argv（--allowedTools mcp__名稱），只准英數、- 與 _；
   HTTP 型要 http(s) url，stdio 型要 command。其餘欄位（headers / env / args）原樣交給 claude，
   它支援 ${ENV} 展開，所以金鑰可以留在環境變數裡、不進圖。 */
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
function validateMcpServers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcpServers 必須是物件');
  const names = Object.keys(raw);
  if (!names.length) throw new Error('沒有任何 MCP 伺服器');
  const out = {};
  for (const name of names) {
    if (!MCP_NAME_RE.test(name)) throw new Error(`伺服器名稱只能用英數、- 與 _（1~64 字）：${String(name).slice(0, 40)}`);
    const sv = raw[name];
    if (!sv || typeof sv !== 'object' || Array.isArray(sv)) throw new Error(`伺服器 ${name} 的設定必須是物件`);
    if (typeof sv.url === 'string') {
      if (!/^https?:\/\//i.test(sv.url)) throw new Error(`伺服器 ${name} 的 url 必須是 http:// 或 https:// 開頭`);
      const type = sv.type || 'http';
      if (type !== 'http' && type !== 'sse') throw new Error(`伺服器 ${name} 的 type 只能是 http 或 sse`);
      out[name] = { type, url: sv.url, ...(sv.headers && typeof sv.headers === 'object' ? { headers: sv.headers } : {}) };
    } else if (typeof sv.command === 'string' && sv.command.trim()) {
      const args = Array.isArray(sv.args) ? sv.args.map(String) : [];
      out[name] = { type: 'stdio', command: sv.command, args, ...(sv.env && typeof sv.env === 'object' ? { env: sv.env } : {}) };
    } else {
      throw new Error(`伺服器 ${name} 需要 url（HTTP）或 command（stdio）`);
    }
  }
  return out;
}
function knownMcpServers() {
  const out = [];
  const push = (scope, servers) => {
    if (!servers || typeof servers !== 'object') return;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const type = cfg.type || (cfg.url ? 'http' : (cfg.command ? 'stdio' : '?'));
      out.push({ name, scope, type, config: cfg });
    }
  };
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const cj = readJson(path.join(os.homedir(), '.claude.json')) || {};
  push('使用者', cj.mcpServers);
  for (const [proj, pc] of Object.entries(cj.projects || {})) {
    push(proj, pc && pc.mcpServers);
    const m = readJson(path.join(proj, '.mcp.json'));
    if (m) push(proj + ' (.mcp.json)', m.mcpServers);
  }
  return out;
}
const MCP_AGENT_SYSTEM = '你是工具操作助理。只用提供給你的 MCP 工具完成任務；需要資料就呼叫工具取得，不要憑記憶編造工具沒有回傳的內容。完成後用繁體中文、精簡地回報結果。';

let warnedMcpCfg = false;
function policyArgs(p) {
  const args = ['--tools', (p.tools || []).join(',')];   // 空陣列 → ""：走 shell 時 shellQuoteArg 會包成 ""
  /* 不載入 user/project/local 的 settings：那裡面的 hooks 與外掛會跑進每一次節點呼叫
     （實測 SessionStart hook 的「要不要幫你設定 statusline」文字直接混進 LLM 節點的回答），
     基底 context 也從 3.2k 再降到 1.1k token。與 SDK 後端的 settingSources 空值一致。
     登入憑證不在 settings 裡，不受影響；managed settings 仍然生效。 */
  args.push('--setting-sources', '');
  // MCP 代理節點會帶自己的設定檔（p.mcpConfigPath）；其他節點一律空設定
  const mcpCfg = p.mcpConfigPath || EMPTY_MCP_CONFIG;
  if (IS_WIN && WIN_UNSAFE_PATH.test(mcpCfg)) {
    // 路徑含 " 或 % 就無法安全進 cmd.exe 命令列（見「命令列安全」）；寧可少一道也不硬拼
    if (p.mcpConfigPath) throw new Error('MCP 設定暫存檔路徑含 " 或 %，無法安全傳給 claude：' + mcpCfg);
    if (!warnedMcpCfg) { warnedMcpCfg = true; console.warn('[policy] 程式目錄路徑含 " 或 %，無法傳 --mcp-config，MCP 工具不會被拔除：' + EMPTY_MCP_CONFIG); }
  } else {
    args.push('--strict-mcp-config', '--mcp-config', mcpCfg);
  }
  for (const t of p.allowed || []) args.push('--allowedTools', t);
  if (p.disallowed?.length) args.push('--disallowedTools', p.disallowed.join(','));
  return args;
}

/* 偵測 claude 是否可用（快取 30 秒） */
let healthCache = null, healthAt = 0;
function checkClaude() {
  if (healthCache && Date.now() - healthAt < 30000) return Promise.resolve(healthCache);
  return new Promise(resolve => {
    const finish = v => { healthCache = v; healthAt = Date.now(); resolve(v); };
    const attempt = (useShell) => {
      const child = spawn('claude', ['--version'], { shell: useShell, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { child.kill(); finish({ ok: false, reason: 'timeout' }); }, 8000);
      child.stdout.setEncoding('utf8');   // 同上：不留 Buffer 拼接的漏網之魚
      child.stdout.on('data', d => out += d);
      child.on('error', e => {
        clearTimeout(timer);
        if (e.code === 'ENOENT' && !useShell) attempt(true);
        else finish({ ok: false, reason: 'not_found' });
      });
      child.on('close', code => {
        clearTimeout(timer);
        finish(code === 0 ? { ok: true, version: out.trim() } : { ok: false, reason: 'exit_' + code });
      });
    };
    attempt(false);
  });
}

/* =====================================================
   檔案讀寫（零依賴：自己處理 zip，支援 docx / xlsx）
   ===================================================== */
const zlib = require('zlib');

/* ---- 最小 zip 讀取器（docx / xlsx 都是 zip） ---- */
function unzip(buf) {
  // 從檔尾找 End of Central Directory (PK\x05\x06)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 檔');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // local header：跳過其自己的 name/extra
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 8 ? () => zlib.inflateRawSync(data) : () => Buffer.from(data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const xmlUnescape = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const xmlEscape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* docx → 純文字 */
function docxToText(buf) {
  const entries = unzip(buf);
  const doc = entries['word/document.xml'];
  if (!doc) throw new Error('docx 內找不到 document.xml');
  let xml = doc().toString('utf8');
  xml = xml.replace(/<w:tab[^>]*\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n');
  xml = xml.replace(/<\/w:p>/g, '\n');
  xml = xml.replace(/<[^>]+>/g, '');
  return xmlUnescape(xml).replace(/\n{3,}/g, '\n\n').trim();
}

/* xlsx → TSV 文字（第一個工作表） */
function xlsxToText(buf) {
  const entries = unzip(buf);
  // 共用字串表
  const shared = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = entries['xl/sharedStrings.xml']().toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlUnescape(m[1].replace(/<[^>]+>/g, '')));
    }
  }
  const sheetName = Object.keys(entries).find(k => /^xl\/worksheets\/sheet1?\.xml$/.test(k))
    || Object.keys(entries).find(k => k.startsWith('xl/worksheets/'));
  if (!sheetName) throw new Error('xlsx 內找不到工作表');
  const xml = entries[sheetName]().toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1], inner = cm[2];
      let v = '';
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      const ism = inner.match(/<is>([\s\S]*?)<\/is>/);
      if (/t="s"/.test(attrs) && vm) v = shared[+vm[1]] ?? '';
      else if (ism) v = xmlUnescape(ism[1].replace(/<[^>]+>/g, ''));
      else if (vm) v = xmlUnescape(vm[1]);
      cells.push(v);
    }
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

/* ---- 最小 zip 寫入器（STORE，不壓縮） ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) { // files: [{name, data:Buffer}]
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* 文字（支援 # 標題與 - 清單的輕量 markdown）→ docx */
function textToDocx(text) {
  const paras = String(text).replace(/\r\n/g, '\n').split('\n').map(line => {
    let style = '', t = line;
    if (/^###\s+/.test(line)) { style = 'Heading3'; t = line.replace(/^###\s+/, ''); }
    else if (/^##\s+/.test(line)) { style = 'Heading2'; t = line.replace(/^##\s+/, ''); }
    else if (/^#\s+/.test(line)) { style = 'Heading1'; t = line.replace(/^#\s+/, ''); }
    else if (/^[-*]\s+/.test(line)) { t = '•  ' + line.replace(/^[-*]\s+/, ''); }
    t = t.replace(/\*\*(.+?)\*\*/g, '$1'); // 去掉粗體記號（簡化）
    const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
    return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r></w:p>`;
  }).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rels) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels) },
    { name: 'word/document.xml', data: Buffer.from(documentXml) },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml) },
  ]);
}

/* 文字（markdown 表格 / TSV / CSV）→ 二維陣列 */
function textToRows(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '');
  const mdTable = lines.filter(l => l.trim().startsWith('|'));
  if (mdTable.length >= 2) {
    return mdTable
      .filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l)) // 去掉分隔列 |---|---|
      .map(l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
  }
  if (lines.some(l => l.includes('\t'))) return lines.map(l => l.split('\t'));
  return lines.map(l => l.split(','));
}

/* 文字 → xlsx */
function textToXlsx(text) {
  const rows = textToRows(text);
  const rowsXml = rows.map((cells, r) =>
    `<row r="${r + 1}">` + cells.map((v, c) => {
      const col = String.fromCharCode(65 + (c % 26));
      const num = v !== '' && !isNaN(Number(v));
      return num
        ? `<c r="${col}${r + 1}"><v>${Number(v)}</v></c>`
        : `<c r="${col}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }).join('') + '</row>'
  ).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rels) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRels) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
  ]);
}

/* 讀檔：依副檔名決定解析方式 */
function readAnyFile(p) {
  const full = path.isAbsolute(p) ? p : path.join(__dirname, p);
  if (!fs.existsSync(full)) throw new Error('找不到檔案：' + full);
  const ext = path.extname(full).toLowerCase();
  const buf = fs.readFileSync(full);
  if (buf.length > 20 * 1024 * 1024) throw new Error('檔案超過 20MB');
  let text;
  if (ext === '.docx') text = docxToText(buf);
  else if (ext === '.xlsx' || ext === '.xlsm') text = xlsxToText(buf);
  else if (ext === '.xls') throw new Error('.xls 為舊版格式，請先用 Excel 另存為 .xlsx');
  else if (ext === '.doc') throw new Error('.doc 為舊版格式，請先用 Word 另存為 .docx');
  else if (ext === '.pdf') throw new Error('PDF 解析尚未支援，請先轉成文字檔');
  else text = buf.toString('utf8');
  const MAX = 200000;
  const truncated = text.length > MAX;
  return { name: path.basename(full), path: full, ext: ext.slice(1), truncated, text: truncated ? text.slice(0, MAX) : text };
}

/* 寫檔：依類型產生檔案 */
function writeAnyFile({ folder, name, type, content }) {
  type = String(type || 'md').toLowerCase();
  const dir = folder
    ? (path.isAbsolute(folder) ? folder : path.join(__dirname, folder))
    : path.join(__dirname, 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let full;
  if (type === 'custom') {
    // 自訂副檔名：檔名自帶副檔名（如 icon.cs、main.py），內容原樣寫出
    const base = (name || '輸出-' + stamp + '.txt').replace(/[<>:"/\\|?*]/g, '_');
    full = path.join(dir, base.includes('.') ? base : base + '.txt');
    const data = Buffer.from(String(content));
    fs.writeFileSync(full, data);
    return { savedPath: full, bytes: data.length };
  }
  const base = (name || '輸出-' + stamp).replace(/[<>:"/\\|?*]/g, '_');
  full = path.join(dir, base + '.' + type);
  let data;
  if (type === 'docx') data = textToDocx(content);
  else if (type === 'xlsx') data = textToXlsx(content);
  else if (type === 'html') data = Buffer.from(
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>${xmlEscape(base)}</title>` +
    `<style>body{font-family:"Segoe UI","Noto Sans TC",sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.8;white-space:pre-wrap}</style>` +
    `</head><body>${xmlEscape(content)}</body></html>`);
  else if (type === 'csv') data = Buffer.from('﻿' + textToRows(content).map(r => r.map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n'));
  else if (type === 'json') {
    try { data = Buffer.from(JSON.stringify(JSON.parse(content), null, 2)); }
    catch { data = Buffer.from(JSON.stringify({ content }, null, 2)); }
  }
  else data = Buffer.from(String(content)); // md / txt
  fs.writeFileSync(full, data);
  return { savedPath: full, bytes: data.length };
}

/* =====================================================
   FlowMap 儲存（每個 FlowMap 一個 JSON 檔，存於 flowmaps/）
   檔案格式：{ id, name, projectId?, visibility?, createdAt, updatedAt,
              graph:{version,nodes,edges}, view }
   visibility：'public'＝跨 Project 可引用；未設＝只在同一個 Project（或同為未分類）內互通。
   Project 清單存於 flowmaps/projects.json。
   ===================================================== */
/* 儲存分成兩個 scope：
     flowmaps/remote/ → **進版控**，團隊共用（.gitignore 不忽略）
     flowmaps/local/  → **不進版控**，只存在這台機器（.gitignore 忽略）
   scope 由「檔案放在哪個資料夾」決定，**不寫進 JSON**：一份資料只有一個真相，
   不會出現「檔案在 local/、欄位卻寫 remote」這種對不上的狀態，使用者手動搬檔也照樣正確。
   Project 同理——它登記在哪個資料夾的 projects.json 就是哪一種；成員 FlowMap 一律
   跟著自己的 Project 走（切換 Project 的 scope＝把成員檔案真的搬過去）。 */
const FM_ROOT = path.join(__dirname, 'flowmaps');
const FM_SCOPES = ['local', 'remote'];
const FM_DIR = { local: path.join(FM_ROOT, 'local'), remote: path.join(FM_ROOT, 'remote') };
const FM_SCOPE_DEFAULT = 'local';        // 新東西一律先落在本機，要分享再自己切成 remote
const fmScopeCheck = sc => (FM_SCOPES.includes(sc) ? sc : null);
const fmDirOf = sc => FM_DIR[fmScopeCheck(sc) || FM_SCOPE_DEFAULT];
const LEGACY_FM_DIR = path.join(__dirname, 'workspaces');

/* 逐檔搬移：同名一律保留目的地現有的不覆蓋，沒搬成的要講清楚，
   不能靜默跳過讓使用者的 FlowMap 在總覽頁憑空消失。 */
function fmMoveFiles(fromDir, toDir, what) {
  let moved = 0; const kept = [];
  fs.mkdirSync(toDir, { recursive: true });
  for (const f of fs.readdirSync(fromDir)) {
    if (!f.endsWith('.json')) continue;
    const from = path.join(fromDir, f), to = path.join(toDir, f);
    if (fs.existsSync(to)) { kept.push(f); continue; }
    try { fs.renameSync(from, to); moved++; }
    catch (e) { kept.push(`${f}（搬移失敗：${e.message}）`); }
  }
  if (moved) console.log(`[flowmap] ${what}：已搬移 ${moved} 個檔案`);
  if (kept.length)
    console.warn(`[flowmap] ⚠ ${what}：下列檔案未搬移（目的地已有同名檔或搬移失敗），請自行確認後手動處理：` +
      kept.join('、'));
  return moved;
}
/* 舊資料自動遷移，兩段接力：
   ① Workspace 時代：workspaces/ → flowmaps/（檔名與 id 不變；納入版控的範例會在 git 顯示 rename）
   ② Local/Remote 分家之前：flowmaps/*.json → flowmaps/remote/
      （分家前整個 flowmaps/ 都納入版控，所以既有資料一律視為 Remote——位置變了，意義沒變） */
try {
  if (fs.existsSync(LEGACY_FM_DIR)) {
    if (!fs.existsSync(FM_ROOT)) {
      fs.renameSync(LEGACY_FM_DIR, FM_ROOT);
      console.log('[flowmap] 已將舊的 workspaces/ 遷移為 flowmaps/');
    } else {
      fmMoveFiles(LEGACY_FM_DIR, FM_ROOT, '舊的 workspaces/ → flowmaps/');
    }
  }
  if (fs.existsSync(FM_ROOT) && fs.readdirSync(FM_ROOT).some(f => f.endsWith('.json')))
    fmMoveFiles(FM_ROOT, FM_DIR.remote, 'flowmaps/ 的扁平結構 → flowmaps/remote/（既有資料視為版控）');
  for (const sc of FM_SCOPES) fs.mkdirSync(FM_DIR[sc], { recursive: true });
} catch (e) { console.error('[flowmap] 舊資料遷移失敗（檔案仍在原處）：' + e.message); }

const FM_ID_RE = /^(fm|ws)-[a-z0-9]+$/;     // 防路徑跳脫；ws- 為舊版 id，繼續相容
const fmNewId = () => 'fm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmPath = (id, scope) => path.join(fmDirOf(scope), id + '.json');
/* 這個 id 的檔案實際在哪個 scope（找不到回 null）——位置就是 scope 的唯一真相 */
function fmFind(id) {
  for (const sc of FM_SCOPES) {
    const p = path.join(FM_DIR[sc], id + '.json');
    if (fs.existsSync(p)) return { scope: sc, path: p };
  }
  return null;
}
function fmLocate(id) {
  const hit = fmFind(fmCheckId(id));
  if (!hit) throw new Error('找不到 FlowMap：' + id);
  return hit;
}
const fmScopeOf = id => fmLocate(id).scope;

function fmCheckId(id) {
  if (!FM_ID_RE.test(String(id || ''))) throw new Error('不合法的 FlowMap id');
  return id;
}
function fmCheckName(name, what = 'FlowMap') {
  const n = String(name || '').trim();
  if (!n) throw new Error(what + ' 名稱不可為空');
  if (n.length > 80) throw new Error(what + ' 名稱過長（上限 80 字）');
  return n;
}
function fmCheckGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('graph 格式不符（需要 nodes / edges 陣列）');
  }
  return { version: 1, nodes: graph.nodes, edges: graph.edges };
}
/* 讀取時順手遷移舊欄位：published:true → visibility:'public' */
function fmNormalize(fm) {
  if (fm.published !== undefined) {
    if (fm.published === true && !fm.visibility) fm.visibility = 'public';
    delete fm.published;
  }
  return fm;
}
function fmRead(id) {
  return fmNormalize(JSON.parse(fs.readFileSync(fmLocate(id).path, 'utf8')));
}
/* 沒指定 scope 就寫回它原本所在的資料夾（新檔才落到預設 scope） */
function fmWrite(fm, scope) {
  const sc = fmScopeCheck(scope) || fmFind(fm.id)?.scope || FM_SCOPE_DEFAULT;
  fs.mkdirSync(fmDirOf(sc), { recursive: true });
  fs.writeFileSync(fmPath(fm.id, sc), JSON.stringify(fm, null, 2));
  return fm;
}
/* 換 scope＝真的搬檔（scope 不是欄位，改欄位沒有意義）。回傳有沒有實際搬動。 */
function fmMove(id, toScope) {
  const sc = fmScopeCheck(toScope);
  if (!sc) throw new Error('不合法的 scope（只接受 local 或 remote）');
  const cur = fmLocate(id);
  if (cur.scope === sc) return false;
  const to = fmPath(id, sc);
  if (fs.existsSync(to)) throw new Error(`${sc} 已經有同 id 的檔案：${id}`);
  fs.mkdirSync(fmDirOf(sc), { recursive: true });
  fs.renameSync(cur.path, to);
  return true;
}

/* ---------- 本機路徑側車（localPaths） ----------
   file / folder 類參數的值是「這台機器」的事——每個使用者的專案放在不同的路徑，
   跟著 FlowMap 本體進版控只會互相覆蓋。因此前端存檔時把這些值抽成
   localPaths（{節點id: {參數key: 路徑}}），存進 flowmaps/local/paths/<id>.json
   （local/ 整個在 .gitignore 裡）；FlowMap 本體裡對應參數一律留空字串。
   讀取（GET 單張，含 🧩 模組執行時載入來源）在路由層機械式合併回圖——
   按節點 id 與參數 key 對位，伺服器不需要知道節點型別。
   本機 scope 的 FlowMap 也走同一套：機制只有一種，scope 搬移只搬檔案、不改寫內容。
   注意搬移這條路上伺服器沒有機會抽路徑（前端只送 { scope }，而伺服器刻意不認得節點
   型別），所以「舊檔本體裡還留著路徑」的情況由前端負責：切 scope 前先呼叫
   washLocalPaths() 讀出來、抽乾淨、存回去，再送 scope。
   相容性：舊檔（路徑還在本體裡）讀取照常——側車只覆蓋它有記錄的欄位；
   下次存檔時前端會把路徑抽進側車，本體隨之淨空。 */
const FM_PATHS_DIR = path.join(FM_DIR.local, 'paths');
function fmPathsFile(id) {
  if (!FM_ID_RE.test(String(id || ''))) throw new Error('不合法的 FlowMap id');
  return path.join(FM_PATHS_DIR, id + '.json');
}
function fmPathsRead(id) {
  try {
    const o = JSON.parse(fs.readFileSync(fmPathsFile(id), 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}
/* localPaths === undefined＝這次請求沒帶（例如總覽的改名／排序 PUT）→ 側車不動 */
function fmPathsWrite(id, localPaths) {
  if (localPaths === undefined) return;
  if (localPaths === null || typeof localPaths !== 'object' || Array.isArray(localPaths))
    throw new Error('localPaths 必須是物件（{節點id: {參數key: 路徑}}）');
  fs.mkdirSync(FM_PATHS_DIR, { recursive: true });
  fs.writeFileSync(fmPathsFile(id), JSON.stringify(localPaths, null, 2));
}
function fmPathsCopy(fromId, toId) {
  try { if (fs.existsSync(fmPathsFile(fromId))) fs.copyFileSync(fmPathsFile(fromId), fmPathsFile(toId)); } catch {}
}
function fmPathsDelete(id) {
  try { fs.unlinkSync(fmPathsFile(id)); } catch {}
}
/* 把側車的路徑合併回圖（就地修改傳入的 fm，回傳它自己）。
   只覆蓋側車有記錄且值非空的欄位；節點已不存在的記錄直接略過（下次存檔會被重建洗掉）。 */
function fmMergePaths(fm) {
  const lp = fmPathsRead(fm.id);
  for (const n of fm.graph?.nodes || []) {
    const o = lp[n.id];
    if (!o || typeof o !== 'object') continue;
    n.params = n.params || {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && v) n.params[k] = v;
  }
  return fm;
}

/* 把 scope 搬移同步標記進 git：從 remote/ 搬走在版控裡就是一次刪除，搬進來就是新增。
   使用者不該還要自己記得補這一刀，所以這裡主動把「剛剛動到的那幾個 remote/ 路徑」加進索引
   （staged，**不自動 commit**——commit 訊息是使用者的事，也不該把別人的暫存內容一起帶走）。
   只送我們自己動過的路徑；local/ 的路徑一律不送（它在 .gitignore 裡，送了只會讓 git add 報錯）。 */
function gitStage(paths) {
  const list = [...new Set(paths)].filter(p => p && p.startsWith(FM_DIR.remote));
  if (!list.length) return { staged: 0 };
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'],
    { cwd: __dirname, encoding: 'utf8', windowsHide: true });
  if (inRepo.status !== 0 || String(inRepo.stdout).trim() !== 'true') return { staged: 0, skipped: '不是 git 專案' };
  let staged = 0; const failed = [];
  for (const p of list) {
    // 逐檔送：沒進過版控的舊路徑會讓整批 git add 失敗，逐檔就只有那一筆落空
    const r = spawnSync('git', ['add', '--', p], { cwd: __dirname, encoding: 'utf8', windowsHide: true });
    if (r.status === 0) staged++; else failed.push(path.basename(p));
  }
  if (staged) console.log(`[git] 已標記 ${staged} 筆 scope 搬移（staged，尚未 commit）`);
  if (failed.length) console.log(`[git] 這幾筆沒標記（多半本來就沒進版控）：${failed.join('、')}`);
  return { staged };
}

/* ---- Project（FlowMap 的分類）---- */
/* 每個 scope 一份 projects.json：Local 的 Project 連名字都不會進版控 */
const pjFile = scope => path.join(fmDirOf(scope), 'projects.json');
const pjNewId = () => 'pj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function pjListIn(scope) {
  const f = pjFile(scope);
  if (!fs.existsSync(f)) return [];
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).list || []).map(p => ({ ...p, scope })); }
  catch (e) {
    // 靜默回空清單等於「這個 scope 的 Project 都不見了」，成員會落到未分類——至少要留下痕跡
    console.error(`[project] ${scope}/projects.json 解析失敗，暫時當作這邊沒有任何 Project：` + e.message);
    return [];
  }
}
/* 兩個 scope 合併成一份清單（每筆帶 scope）；依建立時間排，總覽的區塊順序才跟以前一致 */
function pjList() {
  return [...pjListIn('remote'), ...pjListIn('local')]
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
function pjSaveIn(scope, list) {
  fs.mkdirSync(fmDirOf(scope), { recursive: true });
  fs.writeFileSync(pjFile(scope), JSON.stringify({ list: list.map(({ scope: _s, ...p }) => p) }, null, 2));
}
function pjCheckId(id) {
  if (!/^pj-[a-z0-9]+$/.test(String(id || ''))) throw new Error('不合法的 Project id');
  return id;
}
function pjFind(id) {
  const pj = pjList().find(p => p.id === pjCheckId(id));
  if (!pj) throw new Error('找不到 Project：' + id);
  return pj;
}
/* 同名檢查跨 scope（兩邊各有一個「工具」會讓人分不出誰是誰） */
function pjCreate(name, scope) {
  const sc = fmScopeCheck(scope) || FM_SCOPE_DEFAULT;
  const n = fmCheckName(name, 'Project');
  if (pjList().some(p => p.name === n)) throw new Error('已有同名的 Project：' + n);
  const pj = { id: pjNewId(), name: n, createdAt: new Date().toISOString() };
  pjSaveIn(sc, [...pjListIn(sc), pj]);
  return { ...pj, scope: sc };
}
function pjRename(id, name) {
  const cur = pjFind(id);
  const n = fmCheckName(name, 'Project');
  if (pjList().some(p => p.id !== id && p.name === n)) throw new Error('已有同名的 Project：' + n);
  const list = pjListIn(cur.scope);
  list.find(p => p.id === id).name = n;
  pjSaveIn(cur.scope, list);
  return { ...cur, name: n };
}
/* 切換 Project 的 Local／Remote：成員 FlowMap 的檔案要一起搬。
   搬到一半失敗就把已搬的搬回去，不留下「Project 在 remote、成員還在 local」的半套狀態。 */
function pjSetScope(id, scope) {
  const sc = fmScopeCheck(scope);
  if (!sc) throw new Error('不合法的 scope（只接受 local 或 remote）');
  const cur = pjFind(id);
  if (cur.scope === sc) return { ...cur, moved: 0 };
  const members = fmList().filter(m => m.projectId === id);
  const done = [];
  try {
    for (const m of members) if (fmMove(m.id, sc)) done.push(m.id);
  } catch (e) {
    /* 回退本身也可能失敗（最常見的原因正是「對面已有同 id 的檔案」——也就是觸發回退的
       同一個原因），所以不能吞掉。搬不回來的要指名道姓，使用者才知道要手動處理哪幾個。 */
    const stuck = [];
    for (const mid of done) { try { fmMove(mid, cur.scope); } catch (e2) { stuck.push(`${mid}（${e2.message}）`); } }
    throw new Error(`切換失敗：${e.message}。` + (stuck.length
      ? `⚠ 下列成員沒能退回原位，請手動處理：${stuck.join('、')}`
      : '已搬動的成員都退回原位。'));
  }
  /* 先寫進新 scope、確認成功了才從舊 scope 移除。反過來寫的話，第二步失敗就會讓這個
     Project 在兩份清單裡都不存在，成員檔已經搬走、projectId 還指著它，全部掉進「未分類」。 */
  pjSaveIn(sc, [...pjListIn(sc), { id: cur.id, name: cur.name, createdAt: cur.createdAt }]);
  pjSaveIn(cur.scope, pjListIn(cur.scope).filter(p => p.id !== id));
  // remote 側動到的檔案（成員 + remote/projects.json）直接在 git 標記，使用者不用自己補刪除
  const git = gitStage([pjFile('remote'), ...members.map(m => path.join(FM_DIR.remote, m.id + '.json'))]);
  return { ...cur, scope: sc, moved: done.length, git };
}
/* 刪除 Project。mode：'keep'＝成員移到未分類（預設）；'purge'＝成員 FlowMap 一併刪除 */
function pjDelete(id, mode) {
  const list = pjList();
  if (!list.some(p => p.id === pjCheckId(id))) throw new Error('找不到 Project：' + id);
  const purge = mode === 'purge';
  const members = fmList().filter(m => m.projectId === id);

  /* purge 會刪掉別的 FlowMap 還在引用的來源——前端有紅字警告，但那只是提醒，
     真正該擋的是這裡：後端自己看 referencedBy，被外部引用就整個拒絕，不做一半。 */
  if (purge) {
    const ids = new Set(members.map(m => m.id));
    const blocked = members
      .map(m => ({ m, out: (m.referencedBy || []).filter(r => !ids.has(r.id)) }))
      .filter(x => x.out.length);
    if (blocked.length) {
      throw new Error('下列 FlowMap 仍被這個 Project 之外的 FlowMap 引用，無法連同刪除：' +
        blocked.map(x => `${x.m.name} ←（${x.out.map(r => r.name).join('、')}）`).join('；'));
    }
  }

  /* 逐一處理成員，單一檔案失敗不讓整批停在一半：先把做得到的做完，
     再決定要不要動 projects.json——有失敗就保留 Project，避免出現
     「分類沒了但成員還掛著它的 projectId」的孤兒狀態（那些成員在 UI 上會落到未分類）。 */
  const failed = [];
  let done = 0;
  for (const m of members) {
    try {
      if (purge) { fs.unlinkSync(fmLocate(m.id).path); fmPathsDelete(m.id); }   // 側車一起收，不留孤兒檔
      else fmWrite({ ...fmRead(m.id), projectId: undefined, updatedAt: new Date().toISOString() });
      done++;
    } catch (e) { failed.push(`${m.name}（${e.message}）`); }
  }
  if (failed.length) {
    throw new Error(`已處理 ${done}/${members.length} 個 FlowMap，下列失敗，Project 保留未刪：` +
      failed.join('、'));
  }
  const scope = list.find(p => p.id === id).scope;
  pjSaveIn(scope, pjListIn(scope).filter(p => p.id !== id));
  return { removedProject: id, affected: members.length, mode: purge ? 'purge' : 'keep' };
}

/* 模組介面：FlowMap 內的「節點輸入（modin）」＝模組節點的輸入埠、
   「節點輸出（modout）」＝輸出埠——介面由使用者明確標記，一般的輸入/輸出節點不會變成埠。
   埠名用內部節點 id（穩定，改顯示名稱不會斷線），label 用節點名稱。 */
function fmPorts(graph) {
  const nodes = graph?.nodes || [];
  return {
    // 只放埠的身分與顯示名。預設值是來源自己的事（modin 節點的 params.value），
    // 放進來只會被深拷貝進每個引用端的 _ports 存檔，前端從來不讀。
    inputs: nodes.filter(n => n.type === 'modin')
      .map(n => ({ name: n.id, label: n.params?._label || '節點輸入' })),
    outputs: nodes.filter(n => n.type === 'modout')
      .map(n => ({ name: n.id, label: n.params?._label || '節點輸出' })),
  };
}
/* 這個 FlowMap 引用了哪些 FlowMap（模組節點的來源 id，去重；fmId 為現名、wsId 為舊檔欄位） */
const fmRefs = graph =>
  [...new Set((graph?.nodes || [])
    .filter(n => n.type === 'subflow' && (n.params?.fmId || n.params?.wsId))
    .map(n => n.params.fmId || n.params.wsId))];

const fmMeta = (fm, scope) => ({
  id: fm.id, name: fm.name,
  scope,                                    // 'local'＝不進版控／'remote'＝進版控（由所在資料夾決定）
  projectId: fm.projectId || null,          // null＝未分類
  visibility: fm.visibility === 'public' ? 'public' : 'project',
  order: Number.isFinite(fm.order) ? fm.order : null,   // 手動排序值；null＝未排過（前端以 createdAt 代位）
  createdAt: fm.createdAt, updatedAt: fm.updatedAt,
  nodeCount: fm.graph?.nodes?.length ?? 0,
  edgeCount: fm.graph?.edges?.length ?? 0,
  ports: fmPorts(fm.graph),
  refs: fmRefs(fm.graph),
});
function fmList() {
  const out = [];
  for (const sc of FM_SCOPES) {
    const dir = FM_DIR[sc];
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || !FM_ID_RE.test(f.slice(0, -5))) continue;
      try { out.push(fmMeta(fmNormalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))), sc)); }
      catch { /* 壞檔跳過，不擋整個列表 */ }
    }
  }
  // 被誰引用：給刪除／取消公開時的警告用（附引用者所屬 Project，可判斷是否跨 Project）
  for (const m of out) m.referencedBy = out.filter(o => o.refs.includes(m.id))
    .map(o => ({ id: o.id, name: o.name, projectId: o.projectId }));
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
function fmCreate({ name, graph, view, projectId, scope }) {
  const now = new Date().toISOString();
  const pj = projectId ? pjList().find(p => p.id === projectId) : null;
  if (projectId && !pj) throw new Error('找不到 Project：' + projectId);
  // 有 Project 就跟著 Project 的 scope（成員不跟分類分家）；未分類才看 scope 參數
  const sc = pj ? pj.scope : (fmScopeCheck(scope) || FM_SCOPE_DEFAULT);
  const fm = fmWrite({
    id: fmNewId(), name: fmCheckName(name),
    projectId: projectId || undefined,
    createdAt: now, updatedAt: now,
    graph: graph ? fmCheckGraph(graph) : { version: 1, nodes: [], edges: [] },
    view: view || { tx: 60, ty: 40, s: 1 },
  }, sc);
  return { ...fm, scope: sc };
}
function fmUpdate(id, { name, graph, view, visibility, projectId, order, scope }) {
  const fm = fmRead(id);
  const curScope = fmScopeOf(id);
  let toScope = curScope;
  if (name !== undefined) fm.name = fmCheckName(name);
  if (graph !== undefined) fm.graph = fmCheckGraph(graph);
  if (view !== undefined) fm.view = view;
  if (visibility !== undefined) fm.visibility = visibility === 'public' ? 'public' : undefined;
  if (order !== undefined) {   // 手動排序（拖曳換位置）；null 清除
    if (order !== null && !Number.isFinite(order)) throw new Error('order 必須是數字');
    fm.order = order === null ? undefined : order;
  }
  if (projectId !== undefined) {   // null / '' ＝移到未分類
    const pj = projectId ? pjList().find(p => p.id === projectId) : null;
    if (projectId && !pj) throw new Error('找不到 Project：' + projectId);
    fm.projectId = projectId || undefined;
    if (pj) toScope = pj.scope;    // 進了某個 Project 就跟著它的 scope（未分類則維持原本的）
  }
  if (scope !== undefined) {       // 只有未分類的 FlowMap 能單獨切 scope
    const sc = fmScopeCheck(scope);
    if (!sc) throw new Error('不合法的 scope（只接受 local 或 remote）');
    const pjNow = fm.projectId ? pjList().find(p => p.id === fm.projectId) : null;
    if (pjNow && pjNow.scope !== sc)
      throw new Error(`「${fm.name}」屬於 Project「${pjNow.name}」（${pjNow.scope === 'remote' ? '版控' : '本機'}），` +
        '成員不能單獨切換——請切換整個 Project，或先把它移到未分類');
    toScope = sc;
  }
  fm.updatedAt = new Date().toISOString();
  /* 搬家成功了才落盤內容。反過來先寫再搬的話，fmMove 若 throw（例如對面已有同 id 的檔案），
     API 雖然回錯誤，但新的 projectId 已經持久化——就會變成「分類在對面 scope、檔案還在原地」。 */
  let git;
  if (toScope !== curScope) {
    fmMove(id, toScope);
    fmWrite(fm, toScope);
    git = gitStage([path.join(FM_DIR.remote, id + '.json')]);
  } else {
    fmWrite(fm, curScope);
  }
  return { ...fm, scope: toScope, git };
}
function fmDelete(id) {
  fs.unlinkSync(fmLocate(id).path);
  fmPathsDelete(id);   // 路徑側車一起收掉，不留孤兒檔
}
function fmDuplicate(id) {
  const src = fmRead(id);
  const names = new Set(fmList().map(w => w.name));
  let name = src.name + '（複本）', n = 2;
  while (names.has(name)) name = `${src.name}（複本 ${n++}）`;
  // 複本留在同一個 Project 與同一個 scope；能見度回到預設（不自動公開）
  const copy = fmCreate({ name, graph: src.graph, view: src.view, projectId: src.projectId, scope: fmScopeOf(id) });
  fmPathsCopy(id, copy.id);   // 本機路徑側車跟著複本走（同一台機器，路徑照用）
  return copy;
}

/* ---------- Shell 指令 ----------
   給「❯ Shell 指令」節點用。設計上的兩條底線：

   ① **指令是一整段字串，只交給一個 shell 解析一次。**
      `spawn(shellBin, ['-c', cmd], { shell: false })`——Node 不會再包一層 shell，
      也就不會有「被解析兩次」的問題。Windows 的 cmd.exe 走 `/d /s /c` ＋
      windowsVerbatimArguments，把整段命令列原樣交出去（這是 Node 內部 shell:true 的做法）。
      指令內容本來就是使用者要執行的東西，這裡不做跳脫；**該擋的是「誰能送指令進來」**，
      那道閘門在前端（工具列總開關＋逐段確認）與只綁 loopback 上。
   ② **逾時要殺整棵行程樹。** shell 會再開子行程，只 kill shell 本身會留下孤兒，
      而且節點會謊報「已停止」。POSIX 用 process group、Windows 用 taskkill /T。 */
const SHELLS = ['系統預設', 'bash', 'sh', 'powershell', 'cmd'];
/* 每個串流的上限。原本是 1MB——搬一次 Unity 專案的異動清單（幾千個檔案的路徑）
   就會頂到，被截斷的清單餵給下一步等於漏搬檔案。放寬到 8MB，超過照樣截斷並回報。 */
const SHELL_MAX_OUT = 8 * 1024 * 1024;
const SHELL_MAX_CMD = 100 * 1024;
const ENV_KEY_RE = /^WFG_[A-Z0-9_]{0,60}$/;

function shellSpawnArgs(kind, cmd) {
  const k = SHELLS.includes(kind) ? kind : '系統預設';
  const useCmdExe = (k === 'cmd') || (k === '系統預設' && IS_WIN);
  if (useCmdExe) {
    return {
      bin: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${cmd}"`],
      opts: { windowsVerbatimArguments: true },
      shown: 'cmd.exe',
    };
  }
  if (k === 'powershell') {
    return { bin: IS_WIN ? 'powershell.exe' : 'pwsh',
             args: ['-NoProfile', '-NonInteractive', '-Command', cmd], opts: {},
             shown: IS_WIN ? 'powershell' : 'pwsh' };
  }
  const bin = k === 'bash' ? 'bash' : (k === 'sh' ? 'sh' : '/bin/sh');
  return { bin, args: ['-c', cmd], opts: {}, shown: bin };
}

function killTree(child) {
  if (!child.pid) return;
  if (IS_WIN) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref?.();
}

function runShell({ cmd, cwd, shell, stdin, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const command = String(cmd ?? '');
    if (!command.trim()) return reject(new Error('沒有指令內容'));
    if (command.length > SHELL_MAX_CMD) return reject(new Error('指令太長（上限 100KB）'));

    const dir = cwd
      ? (path.isAbsolute(cwd) ? cwd : path.join(__dirname, cwd))
      : __dirname;
    if (!fs.existsSync(dir)) return reject(new Error(`工作目錄不存在：${dir}`));
    try { if (!fs.statSync(dir).isDirectory()) return reject(new Error(`工作目錄不是資料夾：${dir}`)); }
    catch (e) { return reject(new Error(`無法讀取工作目錄：${e.message}`)); }

    // 只收 WFG_ 開頭的環境變數，值一律轉字串（上游資料當「參數」用的正路）
    const extraEnv = {};
    for (const [k, v] of Object.entries(env || {})) {
      if (ENV_KEY_RE.test(k) && v !== undefined && v !== null) extraEnv[k] = String(v);
    }

    const { bin, args, opts, shown } = shellSpawnArgs(shell, command);
    const ms = Math.min(3600000, Math.max(1000, Number(timeoutMs) || 60000));
    let child;
    try {
      child = spawn(bin, args, {
        cwd: dir,
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
        detached: !IS_WIN,          // POSIX 開新的 process group，逾時才殺得掉整棵樹
        shell: false,               // 關鍵：不讓 Node 再包一層 shell
        ...opts,
      });
    } catch (e) { return reject(new Error(`無法啟動 ${shown}：${e.message}`)); }

    let out = '', err = '', outCut = false, errCut = false, done = false;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      if (done) return; done = true;
      killTree(child);
      reject(new Error(`指令逾時（${Math.round(ms / 1000)}s）已強制結束`));
    }, ms);

    /* stdout／stderr 一律先 setEncoding('utf8')：不設的話 'data' 收到的是 Buffer，
       `out += d` 等於「逐個 chunk 各自 toString()」——一個多位元組字元剛好跨在
       64KB 的 chunk 邊界上就會被拆成兩半、變成兩個 U+FFFD。輸出超過一個 chunk
       又含中文時才會發作，所以症狀是「偶爾有一個字壞掉」。setEncoding 會掛上
       StringDecoder，跨 chunk 的位元組由它保留到下一塊，'data' 直接給正確的字串。 */
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (out.length >= SHELL_MAX_OUT) { outCut = true; return; }
      out += d; if (out.length > SHELL_MAX_OUT) { out = out.slice(0, SHELL_MAX_OUT); outCut = true; }
    });
    child.stderr.on('data', d => {
      if (err.length >= SHELL_MAX_OUT) { errCut = true; return; }
      err += d; if (err.length > SHELL_MAX_OUT) { err = err.slice(0, SHELL_MAX_OUT); errCut = true; }
    });
    child.on('error', e => {
      if (done) return; done = true; clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT'
        ? `找不到 ${shown}。請改選其他 shell，或先安裝它（Windows 想用 bash 需要 Git Bash 或 WSL）`
        : `啟動 ${shown} 失敗：${e.message}`));
    });
    child.on('close', (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({
        code: code === null ? -1 : code, signal: signal || null,
        stdout: out, stderr: err,
        truncated: { stdout: outCut, stderr: errCut },
        durationMs: Date.now() - t0, shell: shown, cwd: dir,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdin === undefined || stdin === null ? '' : String(stdin), 'utf8');
  });
}

/* ---------- 原生檔案/資料夾選擇對話框 ---------- */
/* 伺服器跑在使用者本機，所以能直接開系統的檔案選擇視窗，回傳完整路徑 */
function pickNative(mode, start) { // mode: 'file' | 'folder'；start: 選填，視窗的起始位置
  return new Promise((resolve, reject) => {
    /* 起始位置只是便利功能：驗證存在、正規化成資料夾，驗不過就靜默退回預設行為。
       （file 模式給的是上次選的檔案路徑 → 取其所在資料夾） */
    let startDir = '';
    if (start && typeof start === 'string') {
      try {
        let p = path.resolve(String(start).trim());
        let st = fs.statSync(p);
        if (st.isFile()) { p = path.dirname(p); st = fs.statSync(p); }
        if (st.isDirectory()) startDir = p;
      } catch { /* 路徑不存在就不指定起始位置 */ }
    }
    let cmd, args;
    if (IS_WIN) {
      // PowerShell 單引號字串是純字面值（不展開變數、不吃跳脫），只需把 ' 加倍
      const psq = s => "'" + String(s).replace(/'/g, "''") + "'";
      const ps = mode === 'folder'
        ? `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = '選擇輸出資料夾'
${startDir ? '$f.SelectedPath = ' + psq(startDir) : ''}
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; WindowState='Minimized'; ShowInTaskbar=$false}
if ($f.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }
$owner.Dispose()`
        : `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = '選擇檔案'
$f.Filter = '支援的文件 (*.md;*.txt;*.docx;*.xlsx;*.csv;*.html;*.json)|*.md;*.txt;*.docx;*.xlsx;*.csv;*.html;*.json|所有檔案 (*.*)|*.*'
${startDir ? '$f.InitialDirectory = ' + psq(startDir) : ''}
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; WindowState='Minimized'; ShowInTaskbar=$false}
if ($f.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($f.FileName) }
$owner.Dispose()`;
      cmd = 'powershell';
      args = ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')];
    } else if (process.platform === 'darwin') {
      // AppleScript 字串：跳脫 \ 與 "
      const asq = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const loc = startDir ? ` default location (POSIX file ${asq(startDir)})` : '';
      const script = mode === 'folder'
        ? `POSIX path of (choose folder with prompt "選擇輸出資料夾"${loc})`
        : `POSIX path of (choose file with prompt "選擇檔案"${loc})`;
      cmd = 'osascript'; args = ['-e', script];
    } else {
      cmd = 'zenity';
      args = mode === 'folder' ? ['--file-selection', '--directory'] : ['--file-selection'];
      if (startDir) args.push('--filename=' + startDir + path.sep);
    }
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('選擇逾時')); }, 180000);
    child.stdout.setEncoding('utf8');   // 同上：中文路徑不能被 chunk 邊界拆壞
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', () => { clearTimeout(timer); reject(new Error('此系統無法開啟原生檔案對話框，請手動輸入路徑')); });
    child.on('close', code => {
      clearTimeout(timer);
      const p = out.trim();
      if (p) resolve({ path: p });
      else resolve({ path: '', cancelled: true }); // 使用者按取消
    });
  });
}

/* =====================================================
   程式碼查詢：引用硬後處理（軟約束後面的硬保險）
   提示詞要求「每條陳述附 檔案:行號」只是品質優化；這裡逐筆驗證
   引用指到的檔案真的存在、行號不超過檔案行數。
   雙基準（2026-08-26「正名 repo root」決議）：
     ① 查詢起點（root）——起點內檔案的引用基準
     ② repo 根目錄（repoRoot，git rev-parse 取得）——起點外、repo 內檔案的引用基準
   解析順序：起點相對 → repo 根相對；允許範圍＝整個 repo（無 repo 時＝起點）。
   repo 之外一律無效。無效引用不修改原文（摘要寧缺勿誤），逐筆回報給前端記進日誌；
   rebased＝以 repo 根為基準驗過的筆數（模組外檔案），前端會標示出來。
   ===================================================== */
function validateCitations(text, root, repoRoot) {
  const rootAbs = path.resolve(root);
  const repoAbs = repoRoot ? path.resolve(repoRoot) : null;
  const boundAbs = repoAbs || rootAbs;   // 允許範圍
  const within = abs => abs === boundAbs || abs.startsWith(boundAbs + path.sep);
  /* 抓 `路徑:行號`：路徑要有副檔名（src/a/b.ts:42、E:\x\y.js:10），
     或至少含一個路徑分隔（涵蓋 src/Makefile:3 這類無副檔名檔案）。
     行號 1~6 位。緊跟在 :// 之後的不算（那是 URL 的 host:port，不是引用）。 */
  const re = /((?:[A-Za-z]:[\\/])?(?:[\w.\-]+[\\/])*[\w\-][\w.\-]*\.[A-Za-z0-9]{1,8}|(?:[A-Za-z]:[\\/])?(?:[\w.\-]+[\\/])+[\w.\-]+):(\d{1,6})/g;
  const seen = new Set();
  let checked = 0, rebased = 0;
  const invalid = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (/:\/\/$/.test(text.slice(Math.max(0, m.index - 3), m.index))) continue;   // URL，跳過
    const ref = m[1] + ':' + m[2];
    if (seen.has(ref)) continue;
    seen.add(ref);
    checked++;
    const lineNo = Number(m[2]);
    // 候選解析：起點相對優先，repo 根相對次之（絕對路徑兩者解析結果相同，只會有一個候選）
    const candidates = [path.resolve(rootAbs, m[1])];
    if (repoAbs && repoAbs !== rootAbs) {
      const viaRepo = path.resolve(repoAbs, m[1]);
      if (viaRepo !== candidates[0]) candidates.push(viaRepo);
    }
    let abs = null, viaRepoBase = false, allOutside = true, existsNotFile = false;
    for (let ci = 0; ci < candidates.length && !abs; ci++) {
      const c = candidates[ci];
      if (!within(c)) continue;
      allOutside = false;
      let st;
      try { st = fs.statSync(c); } catch { continue; }
      if (!st.isFile()) { existsNotFile = true; continue; }
      abs = c;
      viaRepoBase = ci > 0;
    }
    if (!abs) {
      invalid.push({
        ref,
        reason: allOutside
          ? (repoAbs ? '指向 repo 根目錄之外' : '指向查詢根目錄之外')
          : (existsNotFile ? '不是檔案' : '檔案不存在（查詢起點與 repo 根兩個基準都找不到）'),
      });
      if (checked >= 500) break;
      continue;
    }
    if (viaRepoBase) rebased++;
    const st = fs.statSync(abs);
    if (st.size <= 5 * 1024 * 1024) {   // 超大檔只驗存在，不逐行數（避免讀爆記憶體）
      try {
        const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
        if (lineNo < 1 || lineNo > lines) invalid.push({ ref, reason: `行號超出範圍（檔案共 ${lines} 行）` });
      } catch { /* 讀不出文字（二進位檔）就只驗存在 */ }
    }
    if (checked >= 500) break;   // 引用數量護欄
  }
  return { checked, invalid, rebased };
}

/* =====================================================
   版本錨點：確定性計算，不經 LLM
   git 專案 → commit hash＋日期（＋是否有未提交變更）
   非 git   → 逐檔 sha256（內容 hash，不依賴 mtime），格式對齊
              version-anchor.json（generated_at / module_path / files）
   ===================================================== */
function runGit(args, cwd, timeoutMs = 15000) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.setEncoding('utf8');   // 同上
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out.trim() : null); });
  });
}

const ANCHOR_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.tmp', 'dist', 'build', '.venv', 'venv']);
function hashFilesRecursive(root, base, files, budget) {
  for (const name of fs.readdirSync(root)) {
    if (budget.count >= budget.max) { budget.truncated = true; return; }
    const full = path.join(root, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (ANCHOR_SKIP_DIRS.has(name)) continue;
      hashFilesRecursive(full, base, files, budget);
    } else if (st.isFile()) {
      const rel = path.relative(base, full).replace(/\\/g, '/');
      if (st.size > 20 * 1024 * 1024) {   // 超大檔不算 hash，但要留下痕跡，不能無聲跳過
        files[rel] = { sha256: null, mtime: st.mtime.toISOString(), skipped: 'file too large (>20MB)' };
      } else {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        files[rel] = { sha256: h, mtime: st.mtime.toISOString() };
      }
      budget.count++;
    }
  }
}

async function versionAnchor(dirPath) {
  const abs = path.resolve(dirPath);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('找不到路徑：' + abs); }
  if (!st.isDirectory()) throw new Error('path 必須是資料夾：' + abs);
  const commit = await runGit(['rev-parse', 'HEAD'], abs);
  if (commit) {
    const dateRaw = await runGit(['show', '-s', '--format=%cI', 'HEAD'], abs);
    const status = await runGit(['status', '--porcelain'], abs);
    return {
      kind: 'git',
      commit,
      commit_date: dateRaw || null,
      dirty: status === null ? null : status.length > 0,   // 有未提交變更時，commit 不足以代表現況
      generated_at: new Date().toISOString(),
      module_path: abs,
    };
  }
  // 非 git：逐檔內容 hash（搬移、還原、同步工具都會動 mtime，所以不能只靠 mtime）
  const files = {};
  const budget = { count: 0, max: 5000, truncated: false };
  hashFilesRecursive(abs, abs, files, budget);
  return {
    kind: 'hash',
    generated_at: new Date().toISOString(),
    module_path: abs,
    files,
    ...(budget.truncated ? { truncated: `超過 ${budget.max} 檔上限，僅計入前 ${budget.max} 檔` } : {}),
  };
}

/* ---------- HTTP 伺服器 ---------- */
/* 累積 Buffer、最後一次 concat 再解碼——不要用 `data += c`：那等於「每個 chunk
   各自 toString()」，多位元組字元跨在 chunk 邊界上就會被拆成兩半變 U+FFFD。
   body 裡就有 Shell 節點的 stdin（幾千個含中文檔名的路徑），上限放寬到 8MB 之後
   必定跨 chunk。順帶：limit 對 Buffer 計數才是真的位元組，不會被字元數混淆。 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

/* ---- AI 端點共用 ---- */
const clampTimeout = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 10000 && n <= 7200000 ? Math.round(n) : def;   // 10s ~ 2h
};
/* 純 LLM／網路查詢呼叫用的空白工作目錄（放在 os 暫存區，不在任何 git repo 內）：
   Claude Code 會沿 cwd 往上載入 CLAUDE.md 等專案脈絡——對純文字節點那是每次呼叫
   都要付費、又與任務無關的 context。cwd 指到空目錄，機制上保證載不到。 */
const LLM_CWD = path.join(os.tmpdir(), 'wfg-llm-cwd');
try { fs.mkdirSync(LLM_CWD, { recursive: true }); } catch {}

/* 三個 AI 端點的共用骨架。
   body 共通欄位：model／timeoutMs（硬上限，10s~2h，超界用預設）／resume（會話 id，延續
   先前呼叫回傳的 sessionId）／stream（true → 回應為 application/x-ndjson：多行
   {"progress":"…"} 進度，最後一行 {"final":true, ...結果或 error}）。
   用戶端斷線（按 ⏹ 中斷）→ 立即砍掉底層 claude 子行程，不留殭屍呼叫。 */
async function aiEndpoint(req, res, tag, body, { defTimeoutMs, buildOpts, logLine, post }) {
  const resume = body.resume ? String(body.resume) : undefined;
  if (resume && !SESSION_RE.test(resume)) return json(res, 400, { error: '不合法的 resume 會話 id' });
  const timeoutMs = clampTimeout(body.timeoutMs, defTimeoutMs);
  const stream = body.stream === true;
  const cancelRef = {};
  let onProgress = null;
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    onProgress = m => { try { res.write(JSON.stringify({ progress: m }) + '\n'); } catch {} };
  }
  res.on('close', () => { if (!res.writableEnded) cancelRef.cancel?.('用戶端已中斷連線'); });
  const t0 = Date.now();
  console.log(`[${tag}] → ${logLine}`);
  try {
    const r = await runClaude({ ...buildOpts(), resume, timeoutMs, onProgress, cancelRef });
    if (post) post(r);
    console.log(`[${tag}] ← ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (r.costUsd ? ` $${r.costUsd.toFixed(4)}` : '') +
      (r.usage ? ` ↑${r.usage.in} ↓${r.usage.out} tok` : '') +
      (r.sessionId ? ` session ${String(r.sessionId).slice(0, 8)}` : ''));
    if (stream) res.end(JSON.stringify({ final: true, ...r }) + '\n');
    else json(res, 200, r);
  } catch (e) {
    console.error(`[${tag}] 錯誤：` + e.message);
    if (stream) { try { res.end(JSON.stringify({ final: true, error: e.message }) + '\n'); } catch {} }
    else json(res, 500, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const bad = guardApi(req);
    if (bad) {
      console.warn(`[guard] 拒絕 ${req.method} ${url.pathname}：${bad}`);
      return json(res, 403, { error: '請求未通過本機來源檢查：' + bad });
    }
  }

  if (url.pathname === '/api/health') {
    return json(res, 200, await checkClaude());
  }

  if (url.pathname === '/api/llm' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: '請求不是合法 JSON' }); }
    if (!body.prompt) return json(res, 400, { error: '缺少 prompt' });
    // LLM 節點是純文字進出：system 整組取代 Claude Code 的 coding agent 提示；
    // cwd 錨定在空白暫存目錄——不讓伺服器所在 repo 的 CLAUDE.md 混進 context。
    return aiEndpoint(req, res, 'llm', body, {
      defTimeoutMs: 900000,
      logLine: String(body.prompt).slice(0, 60).replace(/\n/g, ' ') + '…',
      buildOpts: () => ({
        system: body.system, prompt: body.prompt, model: body.model,
        policy: POLICY.text, systemMode: 'replace', cwd: LLM_CWD,
      }),
    });
  }

  /* MCP 代理：Claude 帶著「節點指定的那幾台 MCP 伺服器」的工具執行任務。
     邊界同樣是機制：--tools ""（內建工具全關）＋ --strict-mcp-config 指到這次呼叫專屬的設定檔
     （只含節點填的伺服器）＋ --allowedTools mcp__<名稱>（否則 headless 下每次工具呼叫都會被拒）。
     設定檔寫在 0600 + wx 的亂數暫存檔，呼叫完即刪。
     stdio 型伺服器等於「在這台機器啟動一個指令」，前端比照 Shell 節點三道閘門（模擬模式不呼叫、
     工具列「允許 Shell」、逐份設定首次確認）；後端這一側用啟動權杖擋跨源直打。 */
  if (url.pathname === '/api/mcpagent' && req.method === 'POST') {
    if (req.headers['x-wfg-token'] !== API_TOKEN)
      return json(res, 403, { error: 'MCP 代理端點需要本次啟動的權杖——請重新整理頁面後再試' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: '請求不是合法 JSON' }); }
    if (!body.prompt) return json(res, 400, { error: '缺少 prompt' });
    let servers;
    try { servers = validateMcpServers(body.mcpServers); } catch (e) { return json(res, 400, { error: 'MCP 設定不合法：' + e.message }); }
    const cfgFile = writeSysPromptFile(JSON.stringify({ mcpServers: servers }), 'wfg-mcp', 'json');
    if (!cfgFile) return json(res, 500, { error: '無法建立 MCP 設定暫存檔（找不到可用的暫存目錄；可設 WFG_TMP）' });
    const names = Object.keys(servers);
    const policy = { tools: [], allowed: names.map(n => 'mcp__' + n), disallowed: ALL_TOOLS, mcpConfigPath: cfgFile, mcpServers: servers };
    try {
      return await aiEndpoint(req, res, 'mcpagent', body, {
        defTimeoutMs: 900000,
        logLine: names.join(',') + ' ｜ ' + String(body.prompt).slice(0, 60).replace(/\n/g, ' ') + '…',
        buildOpts: () => ({
          system: body.system || MCP_AGENT_SYSTEM, prompt: body.prompt, model: body.model,
          policy, systemMode: 'replace', cwd: LLM_CWD,
        }),
      });
    } finally { try { fs.unlinkSync(cfgFile); } catch {} }
  }

  if (url.pathname === '/api/websearch' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: '請求不是合法 JSON' }); }
    if (!body.query) return json(res, 400, { error: '缺少 query' });
    const prompt =
      `請使用網路搜尋工具查詢以下主題，並以繁體中文整理結果：\n\n` +
      `主題：${body.query}\n\n` +
      `${body.instructions || '回傳 3～5 個重點發現，每點附上來源網址。'}\n\n` +
      `只輸出整理後的結果，不要加多餘的前言或結語。`;
    // 開放 WebSearch / WebFetch 工具給這一次呼叫
    return aiEndpoint(req, res, 'websearch', body, {
      defTimeoutMs: 900000,
      logLine: String(body.query).slice(0, 60).replace(/\n/g, ' '),
      buildOpts: () => ({ prompt, model: body.model, policy: POLICY.websearch, cwd: LLM_CWD }),
    });
  }

  if (url.pathname === '/api/codequery' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: '請求不是合法 JSON' }); }
    if (!body.prompt) return json(res, 400, { error: '缺少 prompt' });
    if (!body.folder) return json(res, 400, { error: '缺少 folder（專案根目錄）' });
    const root = path.resolve(String(body.folder));
    let st;
    try { st = fs.statSync(root); } catch { return json(res, 400, { error: '找不到查詢起點資料夾：' + root }); }
    if (!st.isDirectory()) return json(res, 400, { error: '查詢起點必須是資料夾：' + root });
    /* 「正名 repo root」（2026-08-26）：裸 --allowedTools 是無條件自動核准，cwd 之外的讀取
       實際上擋不住（三輪實測證實，模型也確實靠讀模組外的消費者答對過題）。與其宣稱一個
       不存在的邊界，改為誠實語意：查詢起點＝主要範圍與引用基準，同一 repo 內的其他檔案
       可唯讀查閱（盤點「誰在用這個模組」正需要它）；引用驗證的允許範圍＝整個 repo，
       repo 之外一律判無效。repo 根用 git 確定性取得，不是 git 專案就退回單基準（起點）。 */
    const repoRootRaw = await runGit(['rev-parse', '--show-toplevel'], root);
    const repoRoot = repoRootRaw ? path.resolve(repoRootRaw.trim()) : null;
    const hasRepo = !!(repoRoot && repoRoot !== root);
    const system =
      `你是程式碼分析助手。你只有唯讀工具（Read、Grep、Glob），` +
      `沒有 Bash、不能寫檔、不能上網——請直接用唯讀工具查證後回答，不要嘗試其他操作。\n` +
      `查詢起點（工作目錄）：${root}\n` +
      (hasRepo ? `所屬 repo 根目錄：${repoRoot}\n` : '') +
      `查詢對象以查詢起點資料夾為主` +
      (hasRepo ? `；必要時（例如盤點誰在使用此模組）可查閱同一 repo 內的其他檔案，但不得讀取 repo 之外的任何路徑。\n`
               : `，不要讀取起點之外的路徑。\n`) +
      `鐵律：回答中每一條關於程式碼的陳述，都必須附上「檔案路徑:行號」佐證。路徑基準（嚴格遵守）：` +
      `查詢起點內的檔案，寫相對於查詢起點的路徑（起點正下方的 Foo.cs 第 42 行寫 Foo.cs:42、子資料夾寫 sub/Bar.cs:7）` +
      (hasRepo ? `；查詢起點之外、repo 之內的檔案，寫相對於 repo 根目錄的路徑（如 Unity/Assets/Xxx/GameRoot.cs:31）` : '') +
      `；不要自創縮寫路徑。查證不到的就明說「不確定」，不要憑印象回答。` +
      `用繁體中文回答，只輸出答案本身，不要前言或結語。`;
    // 唯讀三件組＋cwd 錨定查詢起點；引用逐筆驗證（雙基準）是軟約束後面的硬保險
    return aiEndpoint(req, res, 'codequery', body, {
      defTimeoutMs: 1800000,
      logLine: `${root}${hasRepo ? `（repo ${repoRoot}）` : ''} ｜ ${String(body.prompt).slice(0, 50).replace(/\n/g, ' ')}…`,
      buildOpts: () => ({
        system, prompt: body.prompt, model: body.model,
        policy: POLICY.codequery,
        systemMode: 'append',   // 保留 Claude Code 的工具使用行為，附加我們的守則
        cwd: root,
      }),
      post: r => {
        r.citations = validateCitations(String(r.text || ''), root, repoRoot);
        console.log(`[codequery] 引用 ${r.citations.checked} 筆（無效 ${r.citations.invalid.length}` +
          (r.citations.rebased ? `，repo 基準 ${r.citations.rebased}` : '') + '）');
      },
    });
  }

  if (url.pathname === '/api/version-anchor') {
    try {
      let p = url.searchParams.get('path') || '';
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        p = body.path || p;
      }
      if (!p) return json(res, 400, { error: '缺少 path（GET ?path=… 或 POST {"path":"…"}）' });
      const anchor = await versionAnchor(p);
      console.log(`[version-anchor] ${anchor.module_path} → ${anchor.kind === 'git' ? anchor.commit.slice(0, 12) + (anchor.dirty ? '（有未提交變更）' : '') : Object.keys(anchor.files).length + ' 檔 hash'}`);
      return json(res, 200, anchor);
    } catch (e) {
      console.error('[version-anchor] 錯誤：' + e.message);
      return json(res, e.message.startsWith('找不到') ? 404 : 500, { error: e.message });
    }
  }

  /* ---- Project API ---- */
  if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
    try {
      const seg = url.pathname.split('/').filter(Boolean); // ['api','projects',id?]
      const id = seg[2];
      if (!id) {
        if (req.method === 'GET') return json(res, 200, { list: pjList() });
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const pj = pjCreate(body.name, body.scope);
          console.log(`[project] 建立：${pj.name}（${pj.id}，${pj.scope}）`);
          return json(res, 200, pj);
        }
      } else {
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req) || '{}');
          let pj = null;
          if (body.name !== undefined) {
            pj = pjRename(id, body.name);
            console.log(`[project] 改名：${pj.name}（${pj.id}）`);
          }
          if (body.scope !== undefined) {
            pj = pjSetScope(id, body.scope);
            console.log(`[project] 切換為 ${pj.scope}：${pj.name}（${pj.id}，搬動 ${pj.moved} 個 FlowMap）`);
          }
          if (!pj) throw new Error('沒有可更新的欄位（name / scope）');
          return json(res, 200, pj);
        }
        if (req.method === 'DELETE') {
          const r = pjDelete(id, url.searchParams.get('mode'));
          console.log(`[project] 刪除：${id}（${r.mode}，影響 ${r.affected} 個 FlowMap）`);
          return json(res, 200, r);
        }
      }
      return json(res, 404, { error: '不支援的 Project 操作' });
    } catch (e) { return json(res, e.message.startsWith('找不到') ? 404 : 400, { error: e.message }); }
  }

  /* ---- FlowMap API ---- */
  if (url.pathname === '/api/flowmaps' || url.pathname.startsWith('/api/flowmaps/')) {
    try {
      const seg = url.pathname.split('/').filter(Boolean); // ['api','flowmaps',id?,action?]
      const id = seg[2], action = seg[3];
      if (!id) {
        if (req.method === 'GET') return json(res, 200, { list: fmList() });
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 30 * 1024 * 1024) || '{}');
          const fm = fmCreate(body);
          fmPathsWrite(fm.id, body.localPaths);
          console.log(`[flowmap] 建立：${fm.name}（${fm.id}）`);
          return json(res, 200, fm);
        }
      } else if (action === 'duplicate' && req.method === 'POST') {
        const fm = fmDuplicate(id);
        console.log(`[flowmap] 複製 ${id} → ${fm.name}（${fm.id}）`);
        return json(res, 200, fm);
      } else if (!action) {
        // 一併回報 scope（local／remote），編輯器頂端要標出這張圖進不進版控。
        // 讀取時把本機路徑側車合併回圖（🧩 模組執行載入來源也走這裡）。
        if (req.method === 'GET') return json(res, 200, fmMergePaths({ ...fmRead(id), scope: fmScopeOf(id) }));
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 30 * 1024 * 1024) || '{}');
          /* 先側車、後本體：反過來的話，本體已經寫成空路徑而側車寫入失敗，
             這次存檔的路徑就消失了。這個順序失敗時最多是側車比本體新，路徑還在。 */
          fmPathsWrite(id, body.localPaths);   // 本機路徑進側車，不進 FlowMap 本體
          const fm = fmUpdate(id, body);
          console.log(`[flowmap] 儲存：${fm.name}（${fm.id}，${fm.graph.nodes.length} 節點）`);
          return json(res, 200, fm);
        }
        if (req.method === 'DELETE') {
          fmDelete(id);
          console.log(`[flowmap] 刪除：${id}`);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: '不支援的 FlowMap 操作' });
    } catch (e) { return json(res, e.message.startsWith('找不到') ? 404 : 400, { error: e.message }); }
  }

  if (url.pathname === '/api/pick' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await pickNative(body.mode === 'folder' ? 'folder' : 'file', body.start);
      if (r.path) console.log(`[pick] ${r.path}`);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/readfile' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.path) return json(res, 400, { error: '缺少 path' });
      const r = readAnyFile(body.path);
      console.log(`[readfile] ${r.path}（${r.text.length} 字元${r.truncated ? '，已截斷' : ''}）`);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/shell' && req.method === 'POST') {
    try {
      /* 前端的三道閘門擋的是「使用者不小心跑到自己匯入的圖」，擋不住「別人主動打這個
         端點」。權杖是後端這一側的門：頁面被服務時才拿得到，跨源拿不到也送不出。 */
      if (req.headers['x-wfg-token'] !== API_TOKEN)
        return json(res, 403, { error: 'Shell 端點需要本次啟動的權杖——請重新整理頁面後再試' });
      // 上限 8MB：stdin 會帶上游的資料（例如幾千個檔案的路徑清單），1MB 不夠用
      const body = JSON.parse(await readBody(req, 8 * 1024 * 1024) || '{}');
      if (!body.cmd) return json(res, 400, { error: '缺少 cmd' });
      const first = String(body.cmd).split(/\r?\n/)[0];
      console.log(`[shell] → (${body.shell || '系統預設'}${body.cwd ? ' @ ' + body.cwd : ''}) ${first.slice(0, 120)}${first.length > 120 ? '…' : ''}`);
      const r = await runShell(body);
      console.log(`[shell] ← 結束碼 ${r.code}${r.signal ? '（' + r.signal + '）' : ''}，${(r.durationMs / 1000).toFixed(1)}s，` +
        `stdout ${r.stdout.length}B stderr ${r.stderr.length}B`);
      return json(res, 200, r);
    } catch (e) {
      console.error('[shell] 錯誤：' + e.message);
      return json(res, 500, { error: e.message });
    }
  }

  /* 本機已設定給 Claude Code 的 MCP 伺服器清單，給 MCP 代理節點的「從 Claude Code 設定帶入」選單。
     來源：~/.claude.json 的 mcpServers（使用者層）、projects[*].mcpServers（專案層）、各專案根的 .mcp.json。
     只供頁面複製：圖裡存的是副本，執行時不會回頭讀這些檔案（圖才能跨機器分享）。
     設定可能含 env／headers 金鑰，所以比照 /api/mcpagent 要求啟動權杖。 */
  if (url.pathname === '/api/mcp/known' && req.method === 'GET') {
    if (req.headers['x-wfg-token'] !== API_TOKEN) return json(res, 403, { error: '需要本次啟動的權杖——請重新整理頁面後再試' });
    return json(res, 200, { list: knownMcpServers() });
  }

  if (url.pathname === '/api/writefile' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req, 30 * 1024 * 1024) || '{}');
      if (body.content === undefined) return json(res, 400, { error: '缺少 content' });
      const r = writeAnyFile(body);
      console.log(`[writefile] ${r.savedPath}（${r.bytes} bytes）`);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // 靜態檔案
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  file = path.normalize(file).replace(/^([.][.][/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const ext = path.extname(full);
    if (ext === '.html') {   // 把本次啟動的權杖交給頁面（不落地、不進快取）
      const html = data.toString('utf8').replace(/__WFG_API_TOKEN__/g, API_TOKEN);
      res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* PID 檔：讓 npm run stop / restart 能跨終端機找到並結束這個程序 */
const PID_FILE = path.join(__dirname, 'server.pid');
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  WorkFlowGraph 已啟動                        │');
  console.log(`│  瀏覽器開啟 →  http://localhost:${PORT}         │`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost')
    console.log(`⚠ 目前綁在 ${HOST}：/api/shell 等端點會對外開放，請確認這是你要的`);
  console.log('│  LLM 節點將使用本機已登入的 Claude Code      │');
  console.log('└─────────────────────────────────────────────┘');
  checkClaude().then(h => {
    if (h.ok) console.log('✓ 偵測到本地 Claude：' + h.version);
    else console.log('✗ 尚未偵測到 claude 指令 — UI 會以模擬模式運作（安裝並登入 Claude Code 後重啟即可）');
  });
});
