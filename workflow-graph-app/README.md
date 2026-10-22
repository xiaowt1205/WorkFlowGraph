# WorkFlowGraph

節點式 AI 工作流編輯器：在畫布上拖節點、拉線組流程，按 ▶ 真實執行。
LLM 運算由**本機已登入的 Claude Code** 驅動——**不需要申請或設定任何 API 金鑰**。

```
拖節點 → 拉線 → ▶ 執行 → 看資料在圖上流動
```

## 特色

- **免金鑰**：LLM／網路查詢節點透過本機 `claude` CLI 執行，走你的 Claude 訂閱授權
- **FlowMap 管理**：工作流以 FlowMap 為單位保存在本機 `flowmaps/`，並可用 **Project** 分類（每個 Project 可設 🔒 本機／☁ 版控，見下方「Local／Remote」）；總覽頁依 Project 分組、左側 outline 快捷跳段，支援新增／重新命名／複製／刪除；卡片可**直接拖曳**換位置（順序會記住）或拖到別的區塊換 Project，🌐 公開的 FlowMap 固定排在區塊最前。進入編輯後 `Ctrl+S` 儲存
- **FlowMap 模組化**：**同一個 Project 的 FlowMap 自動互通**，直接可在彼此的畫布當 🧩 模組節點引用；在總覽勾「🌐 公開」則跨 Project 也能引用。埠由來源的「📥 節點輸入／📤 節點輸出」明確標記（有節點輸入才有輸入埠，輸出同理），執行時載入來源最後儲存的版本（改一處、處處生效），循環引用會被擋下
- **零依賴**：伺服器只用 Node.js 內建模組，`npm start` 直接跑，不用 `npm install`
- **真的可執行**：拓撲排序引擎、條件分支跳過傳播、即時節點狀態、可中斷
- **檔案進出**：讀 docx / xlsx / md 等檔案進工作流，產出 Word / Excel / 任意副檔名檔案
- **模擬模式**：不呼叫 Claude 也能測整張圖的流程邏輯（回假資料、零用量）

## 需求

- Node.js 18+（https://nodejs.org）
- Claude Code 已安裝並登入（終端機打 `claude --version` 有輸出即可）
- 沒裝 Claude Code 也能用：自動退回模擬模式

## 啟動

```
cd workflow-graph-app
npm start          # 前景啟動（Ctrl+C 停止）
npm run stop       # 停止伺服器（任何終端機視窗都可執行）
npm run restart    # 重啟：停止後於背景重新啟動，日誌寫入 server.log
```

瀏覽器開 → **http://localhost:3000**，預設進入 **FlowMap 總覽**（依 Project 分組）：
右上「＋ 新增 Project」建分類、各區塊「＋ FlowMap」建工作流（或點既有卡片開啟），即可進入編輯畫面。
舊版的 `workspaces/` 資料會在伺服器啟動時自動遷移為 `flowmaps/`，內容不變；
`flowmaps/` 底下沒有分層的舊資料則會自動搬進 `flowmaps/remote/`（維持原本「進版控」的意義）。

啟動時自動偵測本機 `claude`：偵測到 → 真實模式（工具列亮綠色「✓ 本地 Claude 已連線」）；
沒偵測到 → 模擬模式。兩者可隨時用工具列的「模擬模式」開關切換。

## 快速上手

1. 總覽頁任一區塊「＋ FlowMap」命名後進入編輯；工具列「📂 範例」可載入內建範例（共 7 個），按畫布右下角**執行控制**窗的「▶ 執行」看整條鏈跑起來
2. 點任何節點，右側檢查器改參數；從左側節點庫拖新節點進畫布
3. 從輸出埠 ● 拉線到輸入埠完成接線；`Del` 刪除、`Ctrl+D` 複製、`Ctrl+Z` 復原
4. 「💾 儲存」（`Ctrl+S`）把 FlowMap 存回本機；「⌂ 總覽」返回總覽頁，有未儲存變更會先詢問
5. 「⤓ 匯出」把整張圖另存成 JSON 檔（檔名採 FlowMap 名稱），「⤒ 匯入」載回（舊版格式自動遷移）

### Local ／ Remote（要不要進版控）

FlowMap 存檔分成兩個資料夾，**scope 由檔案放在哪決定，不是 JSON 裡的欄位**：

| | 資料夾 | 版控 | 用途 |
|---|---|---|---|
| 🔒 **本機 (Local)** | `flowmaps/local/` | **不進**（已列入 `.gitignore`） | 只在這台機器上跑的私人流程、實驗、含敏感路徑的圖 |
| ☁ **版控 (Remote)** | `flowmaps/remote/` | **會進**（git 追蹤） | 團隊共用、要跟著 repo 走的流程與範例 |

- **以 Project 為單位**：每個 Project 屬於其中一邊，成員 FlowMap 一律跟著 Project。
  **點一下 Project 標題旁的徽章就切換**（🔒 本機 ⇄ ☁ 版控），確認後把成員檔案真的搬到另一個資料夾
  （中途失敗會把已搬的退回原位；退不回來的會在錯誤訊息中指名）。
- **未分類的 FlowMap** 自己帶 scope，點卡片上的徽章即可單獨切換。屬於某個 Project 的成員不能單獨切
  （會被擋下），要嘛切整個 Project，要嘛先移到未分類。
- **預設是 🔒 本機**：新建的 Project 與未分類 FlowMap 一律先落在 `local/`，要分享再切成版控。
  建立時也可以直接選「☁ 版控」。
- 把卡片**拖進另一個 scope 的 Project** 會先跳確認——那等於讓它進／出版控。
- **git 會自己記一筆**：切換時伺服器會把 `remote/` 這側動到的檔案加進 git 索引（staged）——
  搬走是刪除、搬進來是新增，你照常 commit 就好，不用自己補 `git rm`。
  **不會自動 commit**（commit 訊息是你的事），也只碰這次動到的那幾個路徑，不影響你其他的暫存內容。
  不是 git 專案就自動略過。
- Local 的 Project 清單存在 `flowmaps/local/projects.json`，**連 Project 名稱都不會進版控**。
- **絕對路徑不進版控**：所有節點的 file / folder 類參數值只要是絕對路徑（`C:\…`／`/home/…`／`~/…`），存檔時就自動抽出，存到 `flowmaps/local/paths/<id>.json`（`.gitignore` 內），FlowMap 本體只留空欄位；相對路徑（如 `outputs/01-facts.md`）可攜，留在本體——**每個使用者的路徑本來就不一樣**，☁ 版控的 FlowMap 因此不會把你的本機路徑外流、也不會被隊友的路徑覆蓋。讀取時自動合併回來（🧩 模組執行也一樣）；「匯出 JSON」仍含路徑（備份／遷移用得到）。

### 畫布操作

| 操作 | 動作 |
|---|---|
| 平移畫布 | 按住**滑鼠中鍵**拖曳，或 `Space` ＋**左鍵**拖曳（游標在節點上也有效） |
| 框選節點 | 在**空白處按左鍵拖曳**；`Shift` ＋框選為加選 |
| 新增節點 | 在**空白處按右鍵**叫出節點清單（可打字搜尋、`↑↓` 選、`Enter` 新增），或從左側節點庫拖入 |
| 拉線到空白處 | 從埠拉線後在**空白處放開**→ 自動開節點清單（只列接得上的型別），選完新增節點並自動接線 |
| 節點指令 | 在**節點上按右鍵**：重新命名（`F2`）／複製／斷開所有連線／刪除；在已框選的節點上按右鍵則對**整組**生效 |
| 加選／退選 | `Shift` ＋點擊節點；`Ctrl+A` 全選 |
| 整組操作 | 拖曳任一選取節點 → 整組移動；`Del` 整組刪除；`Ctrl+D` 整組複製（含節點之間的連線） |
| 縮放 | 滾輪（以游標為中心） |
| 節點重疊 | 選取中的節點會浮到最上層；被壓住的埠，先點一下該節點就能從它拉線 |
| 執行控制 | 畫布**右下角的浮動小窗**：▶ 執行／⏹ 中斷／↩ 重製，加上「狀態、節點數」資訊列。拖**標題列**可移到畫布任一處（位置記在瀏覽器本機），**雙擊標題列**回到右下角預設位置 |

內建範例：① 簡單問答 ② 客服分流（條件分支） ③ 並行摘要翻譯 ④ 網路研究
⑤ 檔案報告（讀檔→整理→依樣板輸出 docx） ⑥ 程式碼產生（輸出限制→存 .cs 檔）
⑦ Unity MCP（MCP 代理：Claude 帶 MCP for Unity 的工具讀 Console 並整理）

## 節點

共 19 種節點：輸入、外部檔案連結、資料夾連結、Prompt 模板、LLM 呼叫、程式碼、Shell 指令、
HTTP 請求、MCP 代理、網路查詢、程式碼查詢、條件分支、合併、輸出檔案、輸出、節點輸入、節點輸出、
FlowMap 模組、註解。

每個節點的用途、參數重點，以及**哪些會呼叫 Claude（產生費用）**，見
[`NODES.md`](./NODES.md)。模擬模式下所有節點都不呼叫 Claude。

## 執行語意（核心概念）

- **拓撲排序**執行，有循環依賴拒跑；任何節點執行時，其所有上游必然已完成／出錯／跳過
- **條件分支**一次只讓一條路通過：未選中側的節點被標記「⊘ 未執行」（不會呼叫、沒有輸出值），沿線傳播直到合併節點
- **多重輸入埠**（模板、合併）：值依接線順序收集；模板要求全部輸入到齊（保留分支閘門效果），合併只要一條活著就執行
- **狀態視覺**：執行中脈動、完成綠框、錯誤紅框、跳過虛線＋⊘；有資料通過的線綠色流動，沒通過的線標 ⊘
- **會話群組**：AI 節點（LLM 呼叫／程式碼查詢）可填「會話名」——同名節點在**同一次執行**中依序共用
  一個 Claude 會話，前面讀過的程式碼與材料以快取計價重用（跨模組邊界也有效，例如段 B 延續段 A 的
  讀碼會話）。會話是顯式資源：留空＝獨立呼叫（預設），共用要作者明確宣告；會話表跑完即棄、不序列化。
  程式碼查詢的會話綁定根目錄，同名不同根目錄不共用（會記日誌並自動開新會話）
- **⏹ 中斷**：立即取消進行中的請求（伺服器同步砍掉底層 claude 子行程）；**↩ 重製**：清除執行狀態回到執行前。
  三顆按鈕都在畫布右下角的**執行控制**浮動窗上，執行中該窗會顯示進度（`執行中 3/12`），結束顯示「完成／N 個錯誤／已中斷」

## 架構

```
瀏覽器 UI（public/index.html — 畫布、檢查器、執行引擎，單檔）
   │  POST /api/llm | /api/websearch | /api/readfile | /api/writefile | /api/pick
   ▼
server.js（Node 內建 http，零依賴）
   │  spawn: claude -p --output-format stream-json（prompt 走 stdin；舊版 CLI 自動退回單包 json）
   │  （可選：WFG_BACKEND=sdk ＋ 已安裝 @anthropic-ai/claude-agent-sdk → 改走 Agent SDK，同一契約）
   ▼
本機已登入的 Claude Code
```

三個 AI 端點共通的 body 欄位：`model`、`timeoutMs`（硬上限 10s~2h）、`resume`（延續先前回傳的
`sessionId`，會話群組用）、`stream`（`true` → 回應為 NDJSON：多行 `{"progress":"…"}` 進度、
最後一行 `{"final":true, ...結果}`）。逾時是**活動式**的：子行程持續有輸出就不會被砍，連續
`WFG_IDLE_MS`（預設 180s）無輸出才視為卡死；`timeoutMs` 是另一層硬上限。用戶端斷線立即砍子行程。

| API | 用途 |
|---|---|
| `GET /api/health` | 偵測本機 claude 版本（30 秒快取） |
| `POST /api/llm` | 純文字補全；呼叫時以 `--tools ""` ＋ `--strict-mcp-config` 空設定**關掉全部工具與 MCP**（白名單制，`--disallowedTools` 為第二道保險），模型只能回文字；cwd 錨定在空白暫存目錄（不吸附任何專案的 CLAUDE.md）；預設硬上限 900s |
| `POST /api/websearch` | 白名單開放 WebSearch / WebFetch，其餘工具拔除；預設硬上限 900s |
| `POST /api/codequery` | 白名單只留唯讀三件組（Read / Grep / Glob），其餘拔除；`cwd` 錨定在查詢起點資料夾，**範圍語意＝整個 repo**（起點為主、同 repo 檔案可讀——「正名 repo root」決議，起點與 repo 根都注入提示）；`檔案:行號` 引用**雙基準逐筆驗證**（起點相對→repo 根相對，repo 之外一律無效，回應含 `rebased` 筆數）；預設硬上限 1800s |
| `POST /api/mcpagent` | Claude 帶著**請求指定的 MCP 伺服器**（HTTP／stdio，可多台）的工具執行任務：`--tools ""` 關掉全部內建工具、`--strict-mcp-config` 指到這次呼叫專屬的設定暫存檔（0600＋亂數檔名，用完即刪）、`--allowedTools mcp__<名稱>`；伺服器名稱只准英數、`-`、`_`。需要啟動權杖（`x-wfg-token`）；**stdio 的閘門在前端**（同 Shell 節點三道）；預設硬上限 900s |
| `GET /api/mcp/known` | 列出本機 Claude Code 已設定的 MCP 伺服器（`~/.claude.json` 的使用者層與專案層、各專案 `.mcp.json`），供 MCP 代理的「從 Claude Code 設定帶入」選單複製用；需要啟動權杖 |
| `/api/version-anchor`（GET `?path=…` 或 POST） | 確定性計算版本錨點：git 專案回 commit＋日期＋dirty，非 git 逐檔 sha256（格式同 version-anchor.json）；不經 LLM |
| `POST /api/shell` | 在本機執行 shell 指令；整段指令只交給一個 shell 解析一次（`spawn(shell, ['-c', cmd], {shell:false})`，Windows 走 `cmd /d /s /c` ＋ verbatim），逾時殺整棵行程樹，stdout／stderr 各上限 1MB。**閘門在前端**（模擬模式／「允許 Shell」總開關／逐段確認），且伺服器只聽 loopback |
| `POST /api/readfile` | 讀檔；docx / xlsx 為零依賴自製解析（自拆 zip + XML） |
| `POST /api/writefile` | 寫檔；docx / xlsx 為零依賴自製產生器 |
| `POST /api/pick` | 開系統原生檔案／資料夾選擇視窗（Windows: PowerShell 對話框）；選填 `start` 指定起始位置 |
| `/api/flowmaps`（GET／POST）、`/api/flowmaps/:id`（GET／PUT／DELETE）、`POST /api/flowmaps/:id/duplicate` | FlowMap 列表／建立／讀取／儲存・改名・移動・能見度・scope／刪除／複製；存於 `flowmaps/<local\|remote>/<id>.json`。列表每筆帶 `scope`；PUT 帶 `scope` 可搬動未分類的 FlowMap |
| `/api/projects`（GET／POST）、`/api/projects/:id`（PUT／DELETE?mode=keep\|purge） | Project 分類的清單／建立（可帶 `scope`，預設 `local`）／改名／切換 `scope`（成員檔案一起搬）／刪除（keep＝成員移到未分類、purge＝成員一併刪除） |

## 專案結構

```
workflowgraph/
├─ CHANGELOG.md            # ★ 每次改動的紀錄（依日期，由新到舊）
├─ CLAUDE.md               # 專案規範（AI 助手與新進者的入口）
├─ .claude/skills/xin-gitcommit/  # commit message 規範與流程（給 AI 助手）
├─ principles/            # ★ 設計規範（動手前必讀）
│  ├─ NODE_PRINCIPLES.md        # 節點設計 — 新增/修改節點必讀
│  └─ INTERACTION_PRINCIPLES.md # 畫布互動 — 改操作模式必讀
└─ workflow-graph-app/
   ├─ server.js            # 本地伺服器：Claude 橋接 + 檔案 API + 靜態服務
   ├─ public/index.html    # 完整前端（畫布 / 引擎 / 檢查器，單檔無建置）
   ├─ scripts/ctl.js       # npm run stop / restart 的控制腳本
   ├─ samples/             # 範例⑤用的原始資料與週報樣板
   ├─ outputs/             # 輸出檔案節點的預設存檔目錄（執行時自動建立）
   ├─ flowmaps/            # FlowMap 存檔目錄（每個 FlowMap 一個 JSON＋各自的 projects.json）
   │  ├─ remote/          #   ☁ 版控：進 git，團隊共用（內含納入版控的範例）
   │  └─ local/           #   🔒 本機：.gitignore 忽略，只存在這台機器
   ├─ NODES.md             # 節點總覽：每種節點的用途與費用
   └─ README.md
```

## 常見問題

- **LLM 節點很慢？** `claude -p` 每次呼叫有 1–3 秒 CLI 冷啟動，屬正常；網路查詢因實際搜尋需 30 秒以上。慢節點每 15 秒會在執行日誌回報進度（工具呼叫次數／已產生字數），活的慢和卡死一眼可辨
- **會被誤判逾時嗎？** 不會因為「工作量大」被砍：逾時是活動式的，持續有輸出就繼續跑；連續 3 分鐘無輸出才視為卡死。真的很大的工作把節點「逾時上限」參數調高即可
- **想消除 CLI 冷啟動？** 在 `workflow-graph-app/` 執行 `npm i @anthropic-ai/claude-agent-sdk`，再以 `WFG_BACKEND=sdk` 環境變數啟動伺服器——改走 Agent SDK 後端（同一契約，前端無感）。不裝不設就維持零依賴的 CLI 路徑
- **LLM 回覆夾雜「無法建立檔案」等說明？** 把該節點的「輸出限制」選成「僅程式碼」或「僅回答內容」；需求描述用「輸出…」而非「創建某檔案」
- **中斷後費用？** 瀏覽器端請求已取消，但已送出的 `claude` 行程會跑完才結束（結果丟棄），該次仍計用量
- **模組引用的是哪個版本？** 執行時載入來源 FlowMap「最後儲存的版本」；編輯中未儲存的變更不會生效。取消公開不影響既有引用，刪除來源則會讓引用它的模組節點執行失敗（刪除前會警告）
- **誰能引用誰？** 同一個 Project（或同為未分類）的 FlowMap 自動互通、不用任何設定；要跨 Project 引用，到總覽把來源勾成「🌐 公開」。能見度只決定能不能「新增」引用，已接好的模組節點照常執行
- **模組節點怎麼決定埠？** 只看來源裡的「📥 節點輸入／📤 節點輸出」——一般的輸入／輸出節點不會變成埠。要把值傳進模組，就在來源加節點輸入；要把結果傳出來，就接到節點輸出，然後儲存
- **FlowMap 存去哪？** 伺服器旁的 `flowmaps/local/<id>.json` 或 `flowmaps/remote/<id>.json`（Project 清單在各自資料夾的 `projects.json`）；要備份或搬移，直接複製整個資料夾即可。舊版 `workspaces/` 與沒分層的 `flowmaps/*.json` 會在啟動時自動遷移
- **手動搬檔案可以嗎？** 可以。scope 就是「檔案在哪個資料夾」，把 JSON 從 `local/` 搬到 `remote/`（或反過來）重整頁面就生效；唯一要顧的是別讓成員跟它的 Project 分家
- **檔案存去哪？** 輸出檔案節點沒填資料夾 → 存伺服器旁的 `outputs/`；可用「📂 瀏覽」選任意資料夾
- **Windows 找不到 claude？** 終端機打 `claude --version` 確認；沒輸出就重裝 Claude Code 並重開終端機
- **舊的工作流 JSON 還能用嗎？** 能，匯入時自動遷移（舊埠名映射、已移除的節點型別自動橋接）

## 開發

動手前先讀 [`principles/`](./principles/) 底下對應的設計規範：

- [`NODE_PRINCIPLES.md`](./principles/NODE_PRINCIPLES.md) — 新增或修改**節點**必讀：
  核心原則（純函數、機制保證能力邊界、單一職責、不允許無聲行為）、埠與連線語意、
  相容性義務（破壞性變更必附匯入遷移）、以及交付前的 11 項 Checklist。
- [`INTERACTION_PRINCIPLES.md`](./principles/INTERACTION_PRINCIPLES.md) — 改**畫布操作模式**必讀：
  輸入分派優先序、拖曳狀態機、選取模型不變式，以及單檔前端的安全修改流程與回歸驗證清單。
