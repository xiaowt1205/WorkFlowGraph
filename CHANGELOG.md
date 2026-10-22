# 變更紀錄

本專案的所有值得記錄的改動都寫在這裡，**依日期由新到舊**排列（不維護版本號）。
格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)：
每則改動歸類到「新增 / 變更 / 修正 / 移除」其中之一，用使用者看得懂的話寫，
必要時在括號補上關鍵檔案或函式，方便日後回溯。

---

## 2026-10-22

### 新增

- **🔌 MCP 工具 節點**：不經 Claude，節點本身當 MCP client 呼叫一個 MCP 伺服器的工具
  （只支援 **Streamable HTTP** 傳輸；stdio 與舊版 HTTP+SSE 不做）。
  參數：伺服器 URL、工具名稱、JSON 參數（`args` 埠接線優先於參數欄，生效的是哪個會寫進日誌）、
  認證環境變數名稱、逾時。**工具名稱留空＝改呼叫 `tools/list`，輸出工具清單**，方便先查名稱與參數。
  輸出規則：工具回 `structuredContent` 就以它為輸出，否則把 content 的文字串起來；
  content 含非文字項目時改輸出整個陣列（都會 log）。工具回 `isError` 視為**節點錯誤**（拋出，
  下游整條標為「上游節點執行失敗」），不另開 fail 埠。模擬模式不連線。
  後端新增 `/api/mcp`（`mcpCall`：initialize → notifications/initialized → tools/call，
  回應 JSON 與 SSE 兩種都收，結束後盡力 DELETE 會話），零相依；比照 `/api/shell` 要求本次啟動的
  `x-wfg-token`。**認證金鑰不進圖**：節點只填環境變數名稱，值在伺服器端才解析成
  `Authorization: Bearer`。沒有「URL／工具名稱」輸入埠——上游只能提供參數，
  呼叫哪台、哪個工具由圖的作者決定（同 Shell 節點不開指令埠的理由）。
  為什麼做成內建節點而不是模組：HTTP 請求節點做不到（需要 initialize 握手、
  `Mcp-Session-Id` 標頭、SSE 回應解析），而「呼叫 MCP 工具」本身與領域無關、是單一動作。
- **MCP 工具 節點的檢查器多了「🔌 測試連線」按鈕**：用檢查器裡**目前填的** URL 與認證環境變數
  做一次 initialize ＋ tools/list，成功顯示伺服器名稱、版本與工具名稱清單，失敗顯示原因
  （連不上、HTTP 狀態碼、環境變數沒值、逾時 15s）。結果只顯示在檢查器與執行日誌，不進圖、
  不存檔；它是診斷動作，**不受模擬模式影響**（真的會連線）。
- **內建範例 ⑦ Unity MCP**：示範用 🔌 MCP 工具 接 MCP for Unity 的 Streamable HTTP 端點
  （預設 `http://127.0.0.1:8080/mcp`）——一顆留空工具名稱列出 Unity 工具清單，另一條鏈用
  `read_console` 讀 Unity Console 的錯誤與警告 → 𝑓 程式碼 轉成 JSON 文字 → ✍ 模板 → 🧠 LLM 整理成摘要。
  前置條件（MCP for Unity 以 HTTP 傳輸啟動、Unity Editor 已連上）寫在範例的註解節點裡。

---

## 2026-09-07

### 新增

- **「搬館 → 回檔驗收」把兩個工具串成一條流程**（「魚機回檔檢測流程」Project，`fm-xferaudit`）。
  先用版控搬移把區間的異動搬進目標版控並 stage，接著**就地驗收**，最後回結論與報告。
  這正是 skill `taipei-delivery-audit` 的心智模型（`搬檔工具寫入 → 驗收 → commit → 開 Unity`）——
  搬館永遠只 stage、不 commit，Unity 也還沒開，剛好就是驗收最便宜的窗口。
  一顆新節點都沒加。**這張圖只做串接，不重複任何編排** ——
  搬館的編排在新的 🧩「版控搬移 · 執行（模組）」裡，跟「版控搬移 · 主流程」引用的是同一份
  （見下方「變更」）。

  **多了一道「目標乾淨嗎？」前置閘門**（❯ Shell），這是比兩個工具單獨跑多出來的唯一檢查。
  目標 repo 有**已追蹤**檔案還沒 commit → 走「失敗」埠中止，**什麼都不搬**。
  擋的是兩件單獨都很難察覺的事：① 搬館會覆寫那些未 commit 的變更；
  ② 驗收的「這批」是 `git diff HEAD`，repo 本來就有的髒東西會被算成這批 →
  **報告不能信，而報告看起來完全正常**。只有未追蹤檔案時放行，並把數量講出來。

  **順序靠資料依賴強制，不靠擺放位置。** 模組的 📤「搬完了」是搬移報告與刪除報告的
  ⇥ 合併（**不設 requireAll**，所以「沒要刪」時只有搬移報告活著也能往下走，
  「有要刪」時會等兩條都結束）；再由 𝑓「驗收對象」吃它、吐出目標版控路徑餵給檢測。
  所以驗收的「專案路徑」**沒有**直接接 📁 目標版控 —— 那樣兩邊沒有資料依賴，
  可能在搬完之前就開始掃。搬移沒跑或失敗時整段驗收跟著跳過。
  同樣的手法用了三次（過乾淨閘門／驗收對象／過擋點）：
  **𝑓 程式碼 吃一條「只是為了排序」的線，吐出真正要用的值。**

  三道閘門的跳過行為已用遞迴模擬逐一驗過（乾淨／不乾淨、有異動／沒異動、要刪／不刪、
  檢測被擋、預覽失敗共六種情境）。**目標不乾淨時整顆搬移模組跳過，連預覽都不跑**
  —— 想在不乾淨的狀態下先看預覽，請跑「版控搬移 · 主流程」，它沒有這道閘門。
  **刻意不暴露「事後基準」**（skill 的 `-Base3`）：剛搬完什麼都沒 commit，
  而事後模式是給「幾週前就 commit 進去了」用的，正好相反 —— 留著只會變成誤填的陷阱；
  真要事後補跑請用「回檔驗收 · 主流程」。

- **回檔驗收做成三張 FlowMap，一顆新節點都沒加**（「魚機回檔檢測流程」Project）。
  把 skill `taipei-delivery-audit` 的**快速模式**拉成工作流：跑檢測 → 判讀 →
  該寫就寫 `快速驗收.md`。**檢測邏輯一行都沒有重寫** —— 圖只負責叫起 skill 的
  `scripts/run.ps1`、解讀它的輸出，那 4.8 萬字元的腳本仍然是 skill 的職責。
  兩個模組（介面用 📥 節點輸入／📤 節點輸出 標記，都能單獨執行測試）：
  **跑檢測**（❯ Shell 叫 `run.ps1` ＋ 𝑓 拆解輸出成 6 個具名埠）、
  **快速判讀**（📄 讀 `SKILL.md` 與 `references/quick-report.md` ＋ 兩顆 🧠）。
  **主流程** 用 🧩 FlowMap 模組把兩者串起來，再接 💾 與 ❯ 落檔。
  實作全部落在既有的通用節點上，不新增節點型別、不新增 API 端點、伺服器沒有改動。

  **擋點都在圖上看得見，不藏在提示詞裡。** 「跑檢測」把六種「先別往下判讀」的狀況
  收斂成一個 📤 擋點 埠，主流程用一顆 ⑂ 擋住：變動 0 檔、Unity 開著（類別三結論不可信）、
  基準數字異常低（樣式失效，**不是專案很乾淨**）、腳本失敗（通常是事後基準的 commit 解不開）、
  沒抓到判定行、沒抓到 skill 資料夾。原本 skill 是用一句「解讀之前先看這幾點」提醒自己，
  現在是機器擋，擋不掉才走到 AI。判定、`⇒ 要寫／不用寫 MD`、`$repDir` 一律用 𝑓 程式碼
  抓，不交給模型讀。

  **「快速模式不要讀 `verdict.md`／`report.md`」也變成機制。** 圖上只有兩顆 📄
  （`SKILL.md` 與 `quick-report.md`），完整模式那幾份判讀文件不在圖上，所以讀不到。

  **沒有寫死任何機器路徑，可以直接給別人用。** repo 由 📁 資料夾連結 給；
  skill 的安裝位置由 Shell 節點在執行的那台機器上用 `$env:USERPROFILE` 推導，
  再經 📤 skill 資料夾 傳給判讀模組去組 `SKILL.md` 與模板的路徑。
  前提只有一個：對方的 `%USERPROFILE%\.claude\skills\taipei-delivery-audit\`
  底下要有這個 skill，沒裝會走「跑不起來」埠並直接講該放哪。

  兩顆 🧠 共用會話名 `tpaudit`（同一批材料以快取重用，第二顆寫 MD 不必重餵）。
  報告落點：💾 先寫進伺服器 `outputs/`，再用一顆 ❯ 搬進腳本印的
  `<repo 上一層>\_ValidateReports\validate_<時間>\`，跟 `findings.csv`、
  `原始檢測.txt` 待在一起（💾 的「輸出資料夾」是手填參數、接不到線，而 `$repDir`
  每次帶時間戳，所以只能先寫再搬；搬檔失敗時檔案還留在 `outputs/`，不會消失）。

  **已知限制**：① 只有 Windows 能跑（檢測本體是 PowerShell 腳本）；
  ② **完整模式還沒做** —— 類別三對照組、判歸屬、九章報告尚未實作，填什麼參數都只走快速模式；
  ③ skill 完整模式的「逐項並行（fan-out）」做不到 —— WorkFlowGraph 沒有 map／loop 節點，
  之後只能一顆節點序列處理全部項目。

### 變更

- **Project「魚機回檔檢測流程」從本機切成版控**（`flowmaps/local/` → `flowmaps/remote/`），
  上面那三張圖因此團隊共用。同 Project 內的兩張實驗用 FlowMap 沒有納入版控。
- **「版控搬移 · 主流程」的編排抽成模組，主流程變成薄殼。**
  新增 🧩「版控搬移 · 執行（模組）」（`fm-xfermod`，「搬館工具」Project，勾 🌐 公開）：
  📥 來源版控／目標版控／commit 區間／同步刪除？ →
  📤 預覽摘要／異動檔案清單／commit 訊息／搬移報告／刪除報告／**搬完了**／沒有異動／失敗訊息。
  編排（⑂ 有異動嗎／⑂ 要同步刪除嗎／兩顆 ✍ 材料模板／𝑓 組參數／𝑓 沒有異動）逐字搬進去。
  「版控搬移 · 主流程」（22 → **13 顆節點**）現在只負責四個參數的輸入介面與七個輸出的顯示。

  **對使用者的行為完全沒變**：四個輸入（📂 瀏覽還在原處）、七個輸出（含顯示名稱）、
  區間語意、閘門、邊界全部照舊；四種情境（有異動／沒異動、要刪／不刪、預覽失敗）
  的跳過行為與拆之前逐項一致（遞迴模擬驗過）。
  唯一改寫的是畫布上的 ✎ 註解 —— 原本列的是「實作在哪三個模組裡」，
  現在改成講「這張圖只是殼、編排在模組裡、為什麼這樣拆」。

  為什麼要拆：編排原本寫在主流程的畫布上，於是「想在別的流程後面接一段」就只能整段複製，
  而「搬館 → 回檔驗收」正是那個需求。拆完之後**編排只有一份**，兩張圖引用同一個模組，
  改政策只改一處。
  為什麼不直接把主流程加 📥／📤 當模組：📥 節點輸入的參數是純文字框、**沒有 📂 瀏覽按鈕**，
  那樣單獨跑搬館就得手打 repo 路徑；「兩種都留」也不行 ——
  📁 資料夾連結 沒填路徑時是 `throw`（節點錯誤）而不是「沒有值」，⇥ 合併 收不起來。
  所以 **📂 瀏覽留在主流程、編排放進模組**。
  `預覽（唯讀）`／`複製並 stage`／`刪除舊檔` 三張子模組**一行都沒改**。

  抽出時把前一天（2026-09-04）加的「stage 清單」一起帶進模組，功能與語意完全保留：
  那顆 ⇥ 合併（**取第一個有值**，接線順序**刪除先、複製後** —— 刪除跑在複製之後，
  它的索引快照才是新的）搬進模組、變成 📤 stage 清單 埠，
  `版控搬移 · 主流程` 與 `搬館 → 回檔驗收` 各接一顆 ⏏ stage 清單（目標版控）。

---


## 2026-09-04

### 新增

- **本機路徑側車：路徑不再寫進 FlowMap 本體**。所有 file / folder 類參數的值
  （程式碼查詢的專案根目錄、資料夾連結、輸出資料夾、外部檔案路徑）在存檔時由前端
  依參數 kind 抽出成 localPaths，存到 `flowmaps/local/paths/<id>.json`（`.gitignore` 內），
  本體對應欄位留空——路徑是**每台機器自己的事**，☁ 版控的 FlowMap 從此不含任何人的
  本機路徑，隊友之間不會互相覆蓋。讀取在伺服器路由層機械式合併回圖（按節點 id 與
  參數 key 對位，不需要知道節點型別），編輯器載入與 🧩 模組執行自然拿到合併後的值。
  **只抽絕對路徑**（`C:\…`／`\\伺服器\…`／`/home/…`／`~/…`）——相對路徑（例如範例圖的
  `outputs/01-facts.md`）是可攜的、不含任何人的機器資訊，留在本體別人 clone 下來才跑得動。
  🔒 本機 scope 也走同一套；scope 搬移只搬檔案不改寫內容，而搬移那條路上前端只送
  `{ scope }`、伺服器又刻意不認得節點型別抽不了，所以**切 scope 前前端會先跑一次
  `washLocalPaths()`**（讀出來→抽乾淨→存回去）再切，舊檔才不會連著絕對路徑被 `git add`。
  複製 FlowMap 側車跟著複本走、刪除（含 Project 連同刪除）一起收掉；
  舊檔（路徑還在本體裡）照常讀取，下次存檔自動抽乾淨。「匯出 JSON」仍含路徑——
  匯出是使用者的明確動作，備份與跨機遷移用得到。
  （`public/index.html` → `splitLocalPaths()`；`server.js` → `fmPathsRead/Write/Copy/Delete()` /
  `fmMergePaths()`，GET／PUT／POST／duplicate／delete 路由對應接上）

- **最近路徑記憶**：所有 file / folder 類參數欄位有「最近用過的路徑」下拉
  （點欄位或打字即出現，file / folder 各記 8 筆、最新在前），「📂 瀏覽」視窗會
  **從上次的位置開起**（欄位有值以欄位為準，否則用最近清單第一筆）。記錄時機：
  瀏覽選定時＋每次執行時掃描圖上所有有值的路徑參數（手打、匯入的也會記到）。
  這是**使用者偏好不是圖的內容**，存瀏覽器 localStorage（同「預設模型」的理由），
  不會寫進 FlowMap、也不會讓存檔被判定成有變更；localStorage 不可用時靜默降級。
  另：路徑本身一直都會隨 FlowMap 儲存（Ctrl+S）——會「消失」通常是改完沒存檔（工具列 ●）。
  （`public/index.html` → `recentPaths()` / `recordRecentPath()` /
  `recordRecentPathsFromGraph()`；`server.js` → `/api/pick` 接受選填 `start`，
  Windows / macOS / Linux 對話框都支援起始位置，start 經存在性驗證、驗不過就退回預設行為）

- **搬館工具：複製／刪除跑完會列出目標版控目前 staged 的清單**（`[STAGED]` 區塊）——
  也就是「接下來 commit 會帶走什麼」，含你自己先 stage 的東西，不只這次搬進來的。
  空 repo（還沒有任何 commit、沒有 HEAD 可比）改拿空樹當基準。
  （`fm-xfercopy` / `fm-xferdel` → `StagedLines()`；主流程新增對應的輸出節點）

### 變更

- **規範：「新增節點」需求一律先做 FlowMap，節點庫只放通用能力。** 原本 `CLAUDE.md` 只寫
  「加節點型別前先過三題」；改成明確的開發順序——收到新增節點的需求，預設是用現有節點組成
  FlowMap 並發布為模組，組不出來才評估新增 `NodeTypes`，且任一題沒過要回頭做 FlowMap 並說明
  理由（`CLAUDE.md` 動手前必讀、`principles/NODE_PRINCIPLES.md` 一之 5）。


## 2026-08-27

### 新增

- **搬館工具：版控搬移做成四張 FlowMap，一顆新節點都沒加**（「搬館工具」Project）。
  把桌面版「版控搬移工具」（C#／Avalonia）的作法移植成工作流，語意逐條對齊：
  區間 `舊commit..新commit` **含頭尾**、異動取**區間淨結果**（基準＝最舊 commit 的 parent）、
  取檔用 git（見下方「取檔不經過 tar」）、**搬完只 stage 永遠不 commit**、
  改名的舊檔算一筆刪除、可重複執行補完。
  三個模組（介面用 📥 節點輸入／📤 節點輸出 標記，都能單獨執行測試）：
  **預覽（唯讀）** 只跑 git 查詢並輸出分區文件（[NEW]／[COPY]／[DELETES]／[MESSAGE] 等）、
  **複製並 stage**、**刪除舊檔**。**主流程** 用 🧩 FlowMap 模組把三者串起來。
  實作全部落在既有的通用節點上——❯ Shell 指令（PowerShell，指令寫在節點裡、
  路徑與清單只走 stdin）＋ 𝑓 程式碼（切分區文件、組 KEY=value 參數）＋
  ⑂ 條件分支 ＋ ✍ Prompt 模板（requireAll 當材料聚合器兼閘門）＋ ⇥ 合併（收三個模組的 stderr）。
  **閘門都在圖上看得見**：⑂「有異動嗎？」空清單就整段跳過（⊘）；⌨「同步刪除？」預設「否」，
  要刪的清單預覽階段已經列出來給人看；刪除那一段還多一條「搬移報告」當前置條件，
  確保排在複製之後且複製成功才做；再加上 Shell 節點本身的三道閘門（模擬模式不呼叫後端、
  工具列「允許 Shell」預設關且不記憶、每段指令首次執行彈確認框）。
  不新增節點型別、不新增 API 端點；伺服器只修了一個既有的編碼 bug（見下方「修正」）。
  舊的「階段一：讀來源 commit 訊息」由主流程取代，已移除。
  **PowerShell 相容性**：腳本必須跑得動 Windows 內建的 **PowerShell 5.1**，
  所以不用任何 6+ 的語法——踩過兩個坑，都寫進腳本開頭的註解：
  ① `` `u{1f} `` 這種 unicode 逃脫是 6.0 才有的，5.1 會退化成字面字元，
  導致 `git log` 的欄位分割全部失敗、每個 commit 都被跳過，最後報「區間無效」
  （一律改用 `[char]0x1f` ＋ `.Split()`）；
  ② PowerShell 會把「單一元素的陣列」自動拆成純量，函式回傳後沒有用 `@()` 包回去，
  `$s[0]` 就變成「字串的第一個字元」（NEW=581264e… 變成 "5"）。
  **取檔不經過 tar**：第一版照桌面版用 `git archive --format=tar` ＋ `tar -xf`，
  在真實的 Unity 專案上失敗——Windows 的 `tar.exe` 是 bsdtar，它用系統碼頁去解 tar 標頭裡
  的檔名，UTF-8 的中文檔名會被解爛，直接吐「…/機率.cs.meta: Invalid empty pathname」
  然後整批中止。改用 **`git checkout-index`**：`GIT_INDEX_FILE` 指到暫存索引、
  `read-tree` 那個 commit、再用 `--prefix=<目標>/ -f` 讓 git 自己寫檔——
  Windows 的 Unicode 路徑由 git 處理，**不會碰到來源 repo 的索引**（已實測來源保持乾淨），
  也省掉「寫暫存 tar 再讀回來」的整包 I/O，而且不再依賴本機有 tar。
  **協定精簡**：預覽只輸出一份機器可讀的 `[CHANGES]`（`狀態<TAB>路徑`），
  人看的清單、複製清單、刪除清單都由模組內的程式碼節點派生——
  原本同時輸出 `[FILES]`／`[COPY]`／`[DELETES]` 三份，5000 檔的專案光這樣就 900KB，
  頂到 Shell 節點的輸出上限；下游模組也只收它真的需要的那一份。
  **commit 內文**：`%b` 為空時退回完整訊息 `%B`，並在最前面講明退回了——
  有些 commit 訊息第一段沒有空行隔開，git 會把整段都當標題，`%b` 因此是空的
  （實測就遇到，桌面版在這種 commit 上也是給空白）。
  另外區間的合法性改用 `git merge-base --is-ancestor` 判斷「舊的是不是新的祖先」，
  不再靠「log 的最後一筆是不是新的那個」——合併 commit 的區間裡，被併進來的分支
  可能有更新的 commit 日期，那種判法會誤判；`git log` 也加上 `--topo-order`，
  拓撲序才是真的「舊到新」。

- **Project 可以選 🔒 本機 (Local) 或 ☁ 版控 (Remote)**：FlowMap 存檔改成兩個資料夾——
  `flowmaps/remote/`（進版控，團隊共用）與 `flowmaps/local/`（`.gitignore` 忽略，只在這台機器）。
  **scope 由檔案放在哪個資料夾決定，不是 JSON 欄位**，所以手動搬檔也照樣正確。
  每個 Project 屬於其中一邊，成員 FlowMap 一律跟著 Project；總覽頁 Project 標題旁的徽章
  **本身就是切換鈕**（點一下 🔒 本機 ⇄ ☁ 版控），確認後把成員檔案真的搬過去；中途失敗會把已搬的退回原位，
  退不回來的（例如對面已有同 id 的檔案）會在錯誤訊息中指名，請自行處理。
  未分類的 FlowMap 自己帶 scope，點卡片上的徽章即可單獨切換；屬於某個 Project 的成員單獨切會被擋下並說明原因。
  **搬移會同步標記進 git**：`remote/` 這側動到的檔案由伺服器 `git add` 進索引（搬走＝刪除、搬進來＝新增），
  使用者不必自己補 `git rm`；只碰這次動到的路徑、**不自動 commit**，不是 git 專案就略過。
  搬完會在總覽頁下方顯示一則短提示（搬到哪、標記了幾筆）。
  新建的 Project／未分類 FlowMap **預設落在 🔒 本機**（建立時也能直接選版控），把卡片拖進
  另一個 scope 的 Project 會先跳確認，編輯器頂端的 FlowMap 名稱旁也會標出目前的 scope。
  Local 的 Project 清單存在 `flowmaps/local/projects.json`，連 Project 名稱都不進版控。
  相容性：既有資料一律視為版控——伺服器啟動時自動把 `flowmaps/*.json`（含 `projects.json`）
  搬進 `flowmaps/remote/`，舊版 `workspaces/` 的遷移照舊接力。
  （`FM_DIR` / `fmFind` / `fmMove` / `pjSetScope`；API：`POST /api/projects` 接受 `scope`、
  `PUT /api/projects/:id` 接受 `scope`、`PUT /api/flowmaps/:id` 接受 `scope`）

### 修正

- **Shell 指令與 AI 節點的輸出，中文不會再偶爾壞掉一個字**：`runShell` 與 `callClaudeCli`
  的 `child.stdout.on('data', d => out += d)` 收到的是 **Buffer**，等於「每個 chunk 各自
  `toString()`」——一個多位元組字元剛好跨在 64KB 的 chunk 邊界上就被拆成兩半、變成兩個 U+FFFD。
  症狀是「輸出超過一個 chunk 又含中文時，偶爾有一個字壞掉」，所以平常不容易發現；
  用它搬 Unity 專案（檔案清單上百 KB、含中文檔名）時就會踩到，而且壞掉的是路徑，
  下一步的 `git archive` 直接 `pathspec did not match any files`。
  四處 spawn（Shell 指令、Claude CLI 串流、原生檔案對話框、版本錨點的 git）全部補上
  `setEncoding('utf8')`，讓 StringDecoder 保留跨 chunk 的位元組。
  五處 spawn（Shell 指令、Claude CLI 串流、`claude --version` 偵測、原生檔案對話框、
  版本錨點的 git）全部補上 `setEncoding('utf8')`，**`readBody()` 也改成累積 Buffer、
  最後一次 `Buffer.concat().toString('utf8')`**——它有一模一樣的毛病，而 body 裡就是
  Shell 節點的 stdin（幾千個含中文檔名的路徑），上限放寬到 8MB 之後必定跨 chunk；
  壞掉的是**進去的**路徑，`checkout-index` 會 `pathspec did not match`。
  順帶讓 `limit` 對 Buffer 計數，才是真的位元組上限。
  （`server.js` → `runShell()` / `callClaudeCli()` / `checkClaude()` / `pickNative()` /
  `runGit()` / `readBody()`）

- **Shell 指令節點的輸出與 stdin 上限從 1MB 放寬到 8MB**：搬一次 Unity 專案的異動清單
  （幾千個檔案的路徑）就會頂到 1MB——輸出被截斷等於清單少了一截、下一步就漏搬檔案；
  stdin 那側則會被 `body too large` 直接擋掉。兩邊都改成 8MB，超過照樣截斷並回報。
  （`server.js` → `SHELL_MAX_OUT`、`/api/shell` 的 `readBody` 上限）

- **只差大小寫的改名不再把剛複製好的新檔刪掉**：預覽把 `R`（改名）拆成「新路徑進 `[COPY]`、
  舊路徑進 `[DELETES]`」，主流程先複製後刪除。遇到 `git mv Foo.cs foo.cs` 這種只差大小寫的
  改名（C#／Unity 很常見），NTFS 大小寫不敏感，刪除模組拿舊路徑去 `Test-Path` 會命中剛寫好
  的新檔並刪掉、還把刪除 stage 起來，淨結果是檔案在目標端消失，重跑同一區間會重現。
  刪除清單現在會濾掉「與複製清單大小寫不敏感相符」的項目，並把濾掉的列進 `[SKIPPED]`
  不靜默跳過。（`fm-xferpreview` → 「刪除清單」程式碼節點）
- **Shell 節點的截斷提示跟著改成 8MB**（前端字串原本還寫 1MB）。
- **切換 Project 的 Local／Remote 不再有「做到一半」的狀態**：
  ① 兩份 `projects.json` 的寫入順序原本是「先從舊 scope 移除、再寫進新 scope」，
  第二步失敗會讓這個 Project 在兩份清單裡都不存在，成員檔已搬走、`projectId` 還指著它，
  全部掉進「未分類」。改成先寫新的、確認成功才移除舊的。
  ② 回退迴圈原本是 `catch {}` 全吞，錯誤訊息卻硬寫「成員已復原到原位」——而回退最可能
  的失敗原因，正是觸發回退的同一個原因（對面已有同 id 的檔案）。改成蒐集退不回來的 id
  並指名附進錯誤訊息，文件與註解的過度保證一併改成實情。
  ③ `fmUpdate` 原本先 `fmWrite` 落盤再 `fmMove`，搬移失敗時新的 `projectId` 已經持久化，
  變成「分類在對面 scope、檔案還在原地」。改成搬移成功後才落盤。
  （`server.js` → `pjSetScope()` / `fmUpdate()`）

### 變更

- **立為原則：內建節點只放通用能力，特定功能做成模組發布**（`principles/NODE_PRINCIPLES.md`
  一之 5、Checklist 第 0 題、`CLAUDE.md` 動手前必讀）。`NodeTypes` 註冊表是通用運算單元的
  集合，不是功能清單；要加節點型別前先過三題——**通用嗎／用現有節點組不出來嗎／是原語而不是
  一串政策嗎**，沒過就用現有節點組成 FlowMap、標好 📥 節點輸入／📤 節點輸出 發布為模組。
  理由是內建節點的成本永久且全域（進節點庫與文件、有人用了就拔不掉、型別名等於長期 API），
  模組沒有這些成本。唯一例外是「非有後端不可、用 Shell 做等於開放任意指令」的能力，
  但原語要切在通用動作那層、不是業務流程那層，並且要寫進決策記錄。
  這條原則立起來之後，同日一度加進註冊表的版控搬移三顆節點（📜 Commit 清單／🧾 區間預覽／
  🔀 版控搬移）**全部拆掉**，`/api/git/log|range|sync` 三個端點一併移除，功能改用既有通用節點
  組成 FlowMap 模組發布——第二題（用現有節點組不出來嗎）它們其實過不了：❯ Shell 指令
  就是那個通用能力。決策記錄裡留了完整的自我對照與代價說明。

- **執行控制移到畫布右下角的浮動小窗**（參考 Unity 粒子播放器）：原本「▶ 執行 / ⏹ 中斷 / ↩ 重製」
  三顆按鈕散在頂端工具列（執行在最右、中斷與重製在左側），改成畫布**右下角的浮動窗「執行控制」**——
  上排 ▶ 執行、下排 ⏹ 中斷 ／ ↩ 重製，再加兩列唯讀資訊：**狀態**（待機／執行中 3/12／完成／
  N 個錯誤／已中斷）與**節點數**。拖**標題列**可把窗移到畫布任一處（會被夾在可視範圍內、
  位置記在瀏覽器 localStorage，不進圖的資料），**雙擊標題列**回到右下角預設位置。
  連帶：畫布左下角改放縮放百分比（原本在右下角，會被新窗壓住）；窗上的滑鼠事件不進畫布分派
  （不會誤觸框選、右鍵節點清單、滾輪縮放），中鍵／`Space`＋左鍵平移仍然可用。
  （`#runpanel` / `placeRunPanel` / `setRunState`，拖曳走 `drag.mode === 'panel'`）

### 新增

- **Project 分類**：總覽頁改為依 Project 分組的區塊（各區塊有「＋ FlowMap／✎ 命名／🗑 刪除 Project」），
  左側 outline 列出所有 Project 與數量、點了捲動到該區塊；右上「＋ 新增 Project」建立分類。
  沒有分類（或分類已被刪除）的 FlowMap 集中在「未分類」區塊。
  刪除 Project 時可選「移到未分類」（只刪分類、保留 FlowMap）或「連同刪除」（成員一併刪除，
  若成員被外部引用會先紅字警告）。Project 清單存於 `flowmaps/projects.json`，
  API 為 `/api/projects`（GET/POST/PUT/DELETE?mode=keep|purge）。
- **卡片拖曳與排序**：FlowMap 卡片可直接拖曳——同區塊內換位置（拖到目標卡片的左半＝插到它前面、
  右半＝插到後面；順序存進 `order` 欄位，重開仍保留），拖到別的區塊＝換 Project；
  🌐 公開的 FlowMap **固定排在區塊最前**（公開群與私有群各自依手動順序，拖曳不會跨群）。
  （`sectionMembers` / `dropFmCard`；`fmUpdate` 接受 `order`）

### 變更（更名與模組共享模型）

- **Workspace 全面更名為 FlowMap**：UI 文字、API（`/api/workspaces` → `/api/flowmaps`）、
  儲存資料夾（`workspaces/` → `flowmaps/`）、程式碼識別字一併改名；新 id 用 `fm-` 前綴。
  相容性：伺服器啟動時自動把舊的 `workspaces/` 搬成 `flowmaps/`（檔名與 id 不變、舊 `ws-` id
  照常可用；納入版控的範例檔會在 git 顯示為 rename，屬預期），模組節點的舊欄位
  （`wsId` / `_wsName`）在開啟或匯入時自動遷移為 `fmId` / `_fmName`。
- **模組共享模型改為「同 Project 自動互通＋公開跨 Project」**（原本是「發布為節點」開關）：
  同一個 Project（或同為未分類）的 FlowMap **直接互相可當節點引用，不需任何設定**；
  要跨 Project 引用，在總覽卡片按「🌐 公開」（有 🌐 徽章），按「↩ 取消公開」收回——
  被其他 Project 引用中時會先警告。能見度只決定能不能**新增**引用，既有模組節點照常執行。
  舊資料的 `published: true` 讀取時自動視為公開。

### 修正

- 「⧉ 複製」的 POST 帶上 `application/json`：新的 API 本機來源檢查要求所有 POST 都是 JSON，
  原本不帶 header 的複製請求會被 403 擋下。
- **舊資料遷移不再在「兩個資料夾並存」時靜默跳過**：原本的條件是「`flowmaps/` 不存在才搬」，
  但這批把 `flowmaps/`（含範例）納入版控，既有使用者 `git pull` 之後一定同時有兩個資料夾——
  條件不成立、整包 `renameSync` 也會失敗，於是**不搬、不警告**，使用者的 FlowMap 在總覽頁
  憑空消失（檔案其實還在 `workspaces/`）。改成並存時逐檔搬移：同名一律保留現有的不覆蓋，
  搬不動的在啟動時列出檔名並警告，不做無聲行為。（`server.js` → `LEGACY_FM_DIR` 遷移段）
- **`projectId` 指到已不存在的 Project 時，FlowMap 不再從 UI 消失**：總覽的區塊只由現有
  Project ＋「未分類」組成，孤兒 `projectId` 不屬於任何區塊，等於開不了、改不了、刪不了。
  `projects.json` 遺失或解析失敗就會觸發。改成「未分類」同時收容沒有 `projectId` 與
  指向不存在 Project 的兩種。（`public/index.html` → `homeProject()` / `sectionMembers()`）
- **刪除 Project 不再做一半**：`purge`（連同刪除成員）先在後端檢查 `referencedBy`——
  被這個 Project 之外的 FlowMap 引用就整個拒絕並列出是誰在引用（原本只有前端紅字警告，
  後端照刪）；成員逐一處理，有任何一個失敗就保留 Project 不刪並回報進度，避免出現
  「分類沒了但成員還掛著它的 projectId」。（`server.js` → `pjDelete()`）
- **重新命名 Project 會檢查同名**（原本只有新增會檢查，可以改出兩個同名分類）。
- **`projects.json` 解析失敗不再靜默**：原本 `catch { return [] }` 等於「所有 Project 都不見了」，
  現在會在伺服器主控台留下錯誤。（`server.js` → `pjList()`）
- **切換 FlowMap 時重設執行控制窗的狀態字**（原本會停在上一張的「完成／N 個錯誤」）。
- 範例 FlowMap：四個 XinCouncil 範例補回 `visibility: 'public'`（等同更名前的
  `published: true`，日後被拆到不同 Project 也還能引用），`view` 回復成整數預設值
  （原本被實際操作的縮放位移覆寫）。
- 陳舊註解與文件校正：`'ws:<id>'` → `'fm:<id>'`、「已發布的 FlowMap」改為「同 Project
  或已公開」、「移至 Project」區段標題改為現況（換 Project 走卡片拖曳），
  `NODES.md` 的「📤 節點輸出」不再寫「發布為節點後」。
- **執行控制小窗「只點一下標題列」不再把位置存成 (0, 0)**：`mouseup` 沒有判斷有沒有真的
  拖過就存檔，而沒拖過時 `style.left` 是空字串、`parseFloat('') || 0` 存成 0——當下畫面不變，
  下次重新載入小窗會跳到畫布左上角。改成有移動才存（`drag.moved`）。

### 移除

- **FlowMap「版控搬移 · 階段一：讀來源 commit 訊息」**：由「版控搬移 · 主流程」取代
  （階段一是用 Shell＋PowerShell 手搭的探路版，只讀 commit 訊息）。
- **一度加進節點庫的版控搬移三顆節點與其後端端點**：📜 Commit 清單、🧾 區間預覽、
  🔀 版控搬移，以及 `POST /api/git/log|range|sync`。原因見上方「內建節點只放通用能力」
  這條原則——它們是特定業務流程，不該進全域註冊表；功能改以 FlowMap 模組提供，
  伺服器與前端回到原狀。

- **FlowMap 卡片的「⇄ 移至」按鈕**：由拖曳取代（拖到別的區塊即換 Project），
  對話框的下拉選單支援一併移除。
- **編輯器工具列的「🧩 發布為節點」切換**：同 Project 已自動互通，公開與否改到總覽的
  Project 管理處操作（卡片上的 🌐 按鈕）；「發布沒有埠的 FlowMap」確認框隨之移除。

### 備註

- 以 Playwright 跑五套自動化測試共 80 項全數通過：FlowMap 基本流程 31 項、模組 20 項、
  Project 23 項（分類 CRUD、拖曳換位置／換 Project、排序持久化、公開置頂、keep/purge 刪除、
  跨 Project 能見度、取消公開警告、舊欄位遷移實測）、條件分支引擎回歸 2 項、
  節點輸入/輸出單獨執行 4 項；
  另實測「用舊版 workspaces/ 檔案啟動自動遷移」與「published → 公開」。
- 本批改動與 8/26–8/27 的其他功能（Shell 指令、程式碼查詢、資料夾連結、成本優化三層、
  預設模型）在同一基底上整合驗證，未動到那些功能的程式路徑。

## 2026-08-26

### 新增（成本優化三層：會話群組／活動式逾時／SDK 後端）

- **會話群組（session 是顯式資源）**：LLM 呼叫與程式碼查詢節點新增「會話名」參數——
  同名 AI 節點在**同一次執行**中依序共用一個 Claude 會話（後面的呼叫 `--resume` 前面的
  session），前面讀過的程式碼與材料以快取計價重用，不必每顆節點重讀重餵。
  規則：留空＝獨立呼叫（預設，隔離是預設值）；會話表屬單次執行（跑完即棄、不序列化、
  不跨執行）；跨模組邊界有效（段 B 可延續段 A 的讀碼會話）；程式碼查詢的會話**綁定根目錄**，
  同名不同根目錄不共用（記日誌並自動開新會話——resume 換 cwd 找不到會話，機制上不允許）。
  所有會話行為都有日誌：首次使用／延續／綁定不符改開新會話。
  （`public/index.html` → `aiSession`/`aiSessionDone`、`runGraph` 會話表；`server.js` → `resume`）
- **AI 節點「逾時上限」參數＋活動式逾時**：逾時從「總時長一刀切」改為兩層——
  ① 活動式：`claude` 改以 `stream-json` 串流執行，子行程持續有輸出（工具呼叫、生成中的
  文字）就不會被砍，連續 `WFG_IDLE_MS`（預設 180s）無輸出才視為卡死；
  ② 硬上限：LLM／網路查詢預設 900s、程式碼查詢預設 1800s，節點參數可調（10s~2h）。
  **工作量大但持續有進度的呼叫不再被誤殺**（先前 R1 回答方 300s 被砍即此因）。
  舊版 CLI 不支援串流旗標時自動退回單包 json（僅硬上限）。（`server.js` → `callClaudeCli`）
- **執行進度即時回報＋中斷真的會停**：AI 端點支援 `stream:true`（NDJSON 回應），每 15 秒
  回報一行「⋯執行中（45s）：工具呼叫 12 次｜最近 Grep …｜已產生 3.2k 字」進執行日誌——
  慢節點是活是死一眼可辨。**⏹ 中斷現在會同步砍掉伺服器端的 claude 子行程**（原本只取消
  瀏覽器請求，子行程照跑照計費）。（`server.js` → `aiEndpoint`/`makeProgressTracker`）
- **Agent SDK 後端（可選）**：`npm i @anthropic-ai/claude-agent-sdk` 並以 `WFG_BACKEND=sdk`
  啟動 → 改走 Agent SDK（同一契約：會話、逾時、進度、工具政策），前端與 Workspace 完全
  無感；不裝不設就維持零依賴的 CLI 路徑。SDK 後端預設不載入 CLAUDE.md／settings，
  基底 context 更乾淨。（`server.js` → `callClaudeSdk`/`runClaude`）

### 變更（同批）

- **XinCouncil Workspace 三層成本優化**（模組為即時引用，重跑即生效）：
  段 A 三視角程式碼查詢共用「讀碼」會話＋降 haiku（事實蒐集屬機械掃描；facts 整併、
  scope 會議等判斷類仍用預設模型）；段 B 兩個回答方接續「讀碼」會話、grill 整理降 haiku
  （拷問官刻意不共用——對抗性需要獨立視角）；段 C references 三檔改為**一次 LLM 產出**
  （`===FILE:` 標記行分隔）＋三顆程式碼節點切檔（省掉兩次重複餵 04-refined 的呼叫，
  標記行遺失會明確報錯不會無聲吞掉），「對碼查證→再次對碼」共用「驗碼」會話（程式碼重用，
  且再驗的視野機制上錨定在第一輪報告、防驗證範圍漂移），「只看skill作答」刻意獨立。
  全流程 Workspace 的「目標模組」填入實際值（不再是佔位例文）、註解補上斷點復原程序。
- **純文字 LLM 呼叫的 cwd 錨定在空白暫存目錄**（os 暫存區，不在任何 git repo 內）：
  原本以伺服器目錄為 cwd，Claude Code 會沿路載入 WorkFlowGraph 自己的 CLAUDE.md——
  與節點任務無關卻每次呼叫都付費的 context。（`server.js` → `LLM_CWD`）
- **程式碼查詢的引用基準明確化**：查詢根目錄的實際路徑注入 system 提示，並要求引用一律
  寫成相對於該根目錄的路徑——實測 237 筆引用 68 筆無效多為模型自選 repo-root 基準或
  自創縮寫，不是引用假。（`server.js` → codequery system）
- **模擬模式的 LLM 輸出尊重提示中的 `===FILE:` 標記行**：下游有依標記切檔的節點時，
  模擬輸出照樣輸出標記，否則模擬測試會白測。（`public/index.html` → `simulateLLM`）
- AI 端點回應新增 `sessionId`；body 新增 `timeoutMs`／`resume`／`stream` 欄位（非 stream
  的舊呼叫方式完全相容）。

### 變更（邊界正名 repo root，依 Justin 決議）

- **程式碼查詢的範圍語意由「只能讀該資料夾」正名為「查詢起點＋整個 repo（唯讀）」**：
  原本宣稱 cwd 是機制保證的邊界（啟動目錄之外會被權限系統擋下）——三輪真實執行推翻了它：
  裸 `--allowedTools Read/Grep/Glob` 是無條件自動核准，越界讀取實際擋不住（第三輪進度日誌
  直接拍到讀取 root 之外的 GameCoinData.cs），而模型也正是靠它答對「誰在用這個模組」。
  與其維持一個不存在的邊界宣稱，改為誠實語意：**指定資料夾＝查詢起點（主要範圍與引用基準），
  同一 repo 內其他檔案可唯讀查閱；repo 之外不允許**。具體改動：
  ① repo 根以 `git rev-parse --show-toplevel` 確定性取得（非 git 專案退回單基準）；
  ② system 提示注入起點與 repo 根、明定雙基準引用規則（起點內寫起點相對、起點外寫 repo 根相對）；
  ③ `validateCitations()` 雙基準解析（起點→repo 根），repo 之外一律判無效，
  回應新增 `rebased`（以 repo 根驗過的模組外引用筆數），前端會標示出來；
  ④ 節點欄位與文件的「只能讀這個資料夾」措辭全數修正（摘要寧缺勿誤）。
  （`server.js` → `/api/codequery`／`validateCitations`；`public/index.html` → codequery）
- **SKILL素材加 References 表對齊規則**：References 表只列實際會產出的三份檔案
  （api／internals／pitfalls），素材分工表提出其他檔名時歸入三份之一——第三輪的 SKILL.md
  曾指向不存在的 `references/remote-integration.md`（該兩處已修正為 internals.md）。
  （`workspaces/ws-councilc.json` → SKILL素材）

### 修正

- **「僅回答內容」補整段圍欄剝除（硬保險）**：模型偶爾把整份輸出包在 ```markdown 圍欄裡，
  直接寫進 md 檔會毀掉它（SKILL.md 的 frontmatter 不在第一行、下游切檔對不到標記）。
  現在「整段就是一個圍欄」時自動剝除並記日誌。判定是逐行配對——第一個非空行是開圍欄、
  最後一個非空行是收圍欄、**中間沒有任何行首圍欄**才剝；單純用 regex 錨定頭尾會誤傷
  「開頭是程式碼區塊、結尾也是程式碼區塊」的正常文件（首尾標記被吃掉、中間圍欄變孤兒，
  比不剝更糟），判不準時寧可不剝。守則也補上
  「不要包圍欄」。實測第三輪全流程的 04-refined.md 與 SKILL.md 都中了這個問題，
  已一併修復落盤的兩個檔案。（`public/index.html` → `LLM_CONSTRAINTS['僅回答內容'].post`）

- **folder 類參數的佔位文字寫死「（預設 outputs/）」**：那是輸出檔案節點的語意，
  出現在程式碼查詢／資料夾連結的空欄位上會誤導（它們留空是錯誤，不是有預設）。
  改為參數可自帶 `ph` 佔位文字（輸出檔案保留原字樣），其餘 folder 欄位顯示
  「或按「瀏覽」選擇資料夾」。（`public/index.html` → 檢查器 filerow 渲染）

### 新增

- **「🔬 程式碼查詢」節點**：對著指定的專案資料夾發問，本地 Claude 以**唯讀工具**
  （Read／Grep／Glob，其餘整組拔掉——沒有 Bash、不能寫檔、不能上網）實際讀碼後回答，
  每條陳述附 `檔案:行號` 引用。範圍以子行程的 `cwd` 錨定在指定資料夾（Claude Code 的
  工作區邊界：啟動目錄之外的檔案存取會被它的權限系統擋下——機制保證，不靠提示詞）。
  回答回來後，後端**逐筆驗證引用**（檔案存在於資料夾內、行號不超過檔案行數；
  URL 的 host:port 不會誤判成引用），無效引用逐筆寫進執行日誌，完全沒有引用也會警告
  ——引用是這個節點的可信度來源，軟約束後面必須跟硬保險。
  逾時同網路查詢（300s）、可中斷、可選模型、模擬模式回罐頭答案。
  為 XinSkillCouncil（模組 skill 產生器）轉 Workspace 而生：事實蒐集、拷問補洞、
  對碼驗證三個階段都靠它。
  專案根目錄可填參數，也可接線到 `folder` 埠（接線優先，同「外部檔案連結」的 path 慣例）
  ——多顆查詢節點就能共用同一個上游來源，模組串接時頂層只要填一次。
  （`public/index.html` → `NodeTypes.codequery`；`server.js` → `/api/codequery` /
  `CODEQUERY_ARGS` / `validateCitations()`；`callClaude()` 新增 `cwd` 選項）
- **「📁 資料夾連結」節點**：輸出**資料夾路徑字串本身**（參數有「📂 瀏覽」原生視窗），
  給程式碼查詢的 folder 埠、HTTP 請求等節點當參考值。與「外部檔案連結」明確分工：
  檔案連結輸出的是**內容**、這顆輸出的是**路徑**——不讓同一顆節點有兩種輸出語意
  （單一職責，同「節點輸入／輸出與一般輸入／輸出分開」的判斷）。不呼叫 Claude、
  模擬模式行為相同。「XinCouncil 全流程」的專案根目錄輸入已改用它。
  （`public/index.html` → `NodeTypes.folderlink`）
- **XinCouncil 工作流四件組**（`workspaces/`）：段 A「事實與範圍」、段 B「拷問與精煉」、
  段 C「產出與驗證」各自可獨立執行（分段跑＝每段之間有人工把關點），三段都已「發布為節點」；
  「XinCouncil 全流程」把三段以 🧩 模組節點串起來全自動跑完——頂層只需填
  目標模組／使用情境／專案根目錄三個輸入，專案根目錄自動餵給三段內所有程式碼查詢節點。
- **`/api/version-anchor` 端點**：確定性計算「版本錨點」，不經 LLM、不給模型 shell。
  git 專案回 `{commit, commit_date, dirty}`；非 git 專案逐檔算 **sha256 內容 hash**
  （不依賴 mtime——搬移、還原、同步工具都會動 mtime），格式對齊 XinSkillCouncil 的
  `version-anchor.json`。跳過 `.git`／`node_modules` 等目錄，超大檔（>20MB）不算 hash
  但留下痕跡，5000 檔上限超過會明說。GET `?path=…` 或 POST `{"path":"…"}` 皆可，
  workflow 裡用現有的「🌐 HTTP 請求」節點呼叫。
  （`server.js` → `versionAnchor()` / `runGit()` / `hashFilesRecursive()`）



### 新增

- **「❯ Shell 指令」節點**：在本機執行 shell 指令（cmd／bash／sh／powershell 可選，可設工作目錄
  與逾時）。輸出比照條件分支：結束碼 0 走「成功」埠送出 stdout、非 0 走「失敗」埠送出 stderr，
  另一邊的下游整條傳染式跳過。上游的值走 **stdin** 與環境變數 **`WFG_IN`**（超過 8KB 只走 stdin
  並在日誌講明）——**沒有「指令」輸入埠，指令只能在節點裡手打**，所以不存在把上游文字拼進
  命令列的注入面。
  這是全 app 風險最高的節點（圖是可匯入、可分享的內容），能力邊界用三道機制擋，不靠提醒：
  ① 模擬模式下**根本不呼叫後端**；② 工具列新增「允許 Shell」總開關，**預設關閉且不持久化**
  （重新整理就回到關閉），關著時節點直接報錯；③ 每一段新的指令內容第一次執行會跳確認對話框，
  核准只在本次開頁有效、指令／shell／工作目錄任一改變就重新詢問，且核准紀錄**不寫進存檔**。
  ④ **後端自己也擋**：只聽 loopback 擋得住同網段的別台機器，擋不住「使用者瀏覽器裡的惡意頁面
  對 localhost 發 POST」——那個請求本來就從 127.0.0.1 發出。所以 `/api/*` 一律檢查 Host（擋
  DNS rebinding）、Origin、以及 POST 的 `Content-Type: application/json`（跨源就無法用不觸發
  preflight 的「簡單請求」偷跑）；`/api/shell` 另外要求 `x-wfg-token`——自訂標頭必定觸發
  preflight 而我們不回任何 CORS 標頭，權杖每次啟動重產、由伺服器在服務頁面時填入，不落地。
  前端三道閘門擋的是「使用者不小心跑到自己匯入的圖」，這一道擋的是「別人主動打這個端點」。
  「跑不起來」（開關關著／取消／逾時／找不到 shell／工作目錄不存在）算節點錯誤，不是「失敗」分支。
  逾時會殺掉整棵行程樹（POSIX 用 process group、Windows 用 `taskkill /T`），不留孤兒行程；
  stdout／stderr 各最多 1MB，截斷會在日誌講明。
  （`public/index.html` → `NodeTypes.shell` / `#tg-shell` / `shellApproved`；
  `server.js` → `runShell()` / `shellSpawnArgs()` / `killTree()` / `POST /api/shell`）
- **伺服器改為只聽 `127.0.0.1`**（原本 `server.listen(PORT)` 綁全部介面）。有了 `/api/shell`
  之後，綁 `0.0.0.0` 等於把「在我機器上執行指令」開放給同網段的任何人；`/api/writefile`
  與 `/api/readfile` 其實早就該收。真要對外自己設 `HOST=0.0.0.0`，啟動時會印警告。
- **工具列的「預設模型」**：一次決定所有 AI 節點要用哪個模型（跟隨 Claude Code／haiku／
  sonnet／opus），不必一顆一顆設。節點自己選了模型時以節點為準；節點卡片會寫出實際會用的是
  哪一個（`預設→sonnet`），不用猜。這是**使用者偏好不是圖的內容**，存在瀏覽器本機
  （`localStorage`），不會寫進 Workspace，也不會讓存檔被判定成有變更。
  （`public/index.html` → `#sel-model` / `resolveModel()` / `modelLabel()`）
- **「🔍 網路查詢」節點可以選模型了**：先前它是唯一不能選模型的 AI 節點，只能吃預設；
  而它通常是整張圖**最貴也最慢**的一顆（實測一次搜尋 111.6s、$0.60，占全程 62%）。
  後端 `/api/websearch` 本來就吃 `model`，補上前端的參數與傳遞即可。
  「💾 輸出檔案」的樣板重排（也會呼叫 Claude）同樣改吃預設模型。

- **「📥 節點輸入」與「📤 節點輸出」兩種節點**：明確標記 Workspace 的模組介面。
  節點輸入＝模組節點左側的輸入埠（帶預設值：單獨執行或埠沒接線時使用）；
  節點輸出＝右側的輸出埠（單獨執行時同「輸出」，顯示收到的值方便來源自己測試）。
  （`NodeTypes.modin` / `NodeTypes.modout`）
- **Workspace 模組化（發布為節點）**：Workspace 可「發布為節點」，在其他 Workspace 中
  當作 🧩 模組節點引用。埠由來源的「節點輸入／節點輸出」**明確決定**——有節點輸入
  才有輸入埠、有節點輸出才有輸出埠（埠名用內部節點 id，改顯示名稱不斷線），
  一般的輸入／輸出節點不會變成埠。
  引用是**即時的**：執行時載入來源「最後儲存的版本」，改一處、處處生效。
  執行時模組顯示為單一節點（讀秒、狀態、AI 用量費用彙總），內部每個節點的進度以
  「▸ 節點名」逐筆寫進執行日誌；內部條件分支沒選中的輸出埠不 emit，閘門效果向外傳播；
  任一內部節點出錯＝模組節點錯誤（訊息標明是哪個內部節點）。
  （`NodeTypes.subflow` / `runSubgraph`，引擎核心抽出共用的 `topoOrder` / `collectPortInputs`）
- **發布入口與模組清單**：總覽卡片與編輯器工具列都有「🧩 發布為節點」切換（已發布的卡片
  顯示徽章）；已發布的 Workspace 出現在左側節點庫的「Workspace 模組」區與畫布右鍵清單
  （可搜尋、可拉線自動接埠）。清單自動排除自己與會造成循環的來源。
  （`renderModulePalette` / `moduleCandidates` / `setPublished`；`server.js` 的 Workspace
  meta 新增 `published` / `ports` / `refs` / `referencedBy`）
- **模組的防呆**：循環引用（直接或間接引用自己）在加入清單時排除、執行時以 visited 集合
  硬性擋下（巢狀上限 8 層）；刪除被引用的 Workspace 時，確認框警告會列出引用者；
  取消發布時同樣警告（既有引用不受影響，只是不能再新增）；發布沒有節點輸入／節點輸出的
  Workspace 會先確認；來源被刪除的模組節點標示「⚠ 來源已不存在」、執行時明確報錯。
- **模組埠自動同步**：開啟 Workspace 時，模組節點的埠定義與來源最後儲存版本對齊
  （名稱、埠增減）；指向已消失埠的連線會移除並記進日誌（不做無聲行為）。（`syncSubflowPorts`）
- **Workspace 總覽頁**：編輯的對象正名為 **Workspace**（一個 Workspace＝一張工作流圖），
  開啟 http://localhost:3000 的預設畫面改為總覽頁，列出所有 Workspace 卡片，
  支援**新增（先命名）／重新命名／複製／刪除（有確認對話框，會顯示名稱與節點數）**；
  點卡片進入該 Workspace 的編輯畫面（原本的畫布）。
  （`public/index.html` → `#overview` / `loadOverview` / `wsCreateFlow` 等）
- **Workspace 持久化**：每個 Workspace 存成本機 `workflow-graph-app/workspaces/<id>.json`
  （含圖、視角與時間戳），由 `server.js` 新增的 Workspace API 讀寫
  （`GET/POST /api/workspaces`、`GET/PUT/DELETE /api/workspaces/:id`、
  `POST /api/workspaces/:id/duplicate`），零依賴；`workspaces/` 已加入 `.gitignore`。
- **編輯器的「💾 儲存」與「⌂ 總覽」**：工具列左側顯示目前 Workspace 名稱，
  有未儲存變更時名稱旁出現 ● 標記；`Ctrl+S` 或按「儲存」寫回檔案。
  按「⌂ 總覽」返回總覽頁，若有未儲存變更會先詢問（儲存後離開／放棄變更／取消）；
  關閉或重新整理分頁時若有未儲存變更，瀏覽器也會攔一次。執行中不可返回總覽，需先中斷。
- **執行中的節點即時讀秒**：節點標題右側顯示 `執行中 12.3s`（每 0.1 秒更新，
  超過一分鐘改為 `1:23`）。只改該節點 `.st` 的文字、不觸發整頁重繪；
  節點完成、出錯、被 `⏹ 中斷` 或被刪除時都會停掉計時器。
  （`startNodeTimer` / `stopNodeTimer` / `runningText`）
- **AI 節點顯示這一步花掉的 token**：LLM 呼叫、網路查詢，以及輸出檔案節點的樣板重排，
  執行完會在節點上多一列 `↑輸入 ↓輸出 tok · 費用 · 耗時`；右側檢查器展開明細
  （新送出／快取讀取／快取建立）；工具列與執行日誌結尾顯示本次執行總計，
  「↩ 重製」或重新執行時歸零。模擬模式不顯示。
  （`server.js` 的 `normUsage()` 把 CLI 的 `usage` 帶出來，前端新增 `ctx.meter()` 回報管道
  與 `addUsage` / `updateUsageTotal`）

- **畫布右鍵節點清單**：在畫布空白處按右鍵叫出節點清單，可打字搜尋、`↑` `↓` 選取、
  `Enter` 新增、`Esc` 關閉；新節點以游標位置為中心落下。在節點或連線上按右鍵不會叫出清單。
  （`public/index.html` → `openCtxMenu` / `renderCtxList` / `ctxAdd`）
- **框選節點**：在畫布空白處按左鍵拖曳拉出膠框，矩形相交即選中；按住 `Shift` 拖曳為加選。
  拖曳過程只切換 CSS class 不重繪整張圖，節點多時仍流暢。（`drag.mode === 'marquee'`）
- **多選操作**：`Shift`＋點擊節點加選／退選、`Ctrl+A` 全選、拖曳任一選取節點可整組移動、
  `Del` 整組刪除、`Ctrl+D` 整組複製（**節點之間的連線一併複製**）。（`duplicateNodes`）
- **多選時的檢查器**：右側面板顯示「已選取 N 個節點」與該狀態下可用的操作提示。
- **拉線到空白處自動開節點清單**：從任一輸入／輸出埠拉線，放開在畫布空白處時會叫出節點清單，
  且**只列出接得上的節點型別**（從輸出埠拉 → 只列有輸入埠的；從輸入埠拉 → 只列有輸出埠的）；
  選定後新增節點、自動接線，並依資料流方向擺在游標的下游或上游側。新增節點與接線算同一步，
  `Ctrl+Z` 一次復原。（`openCtxMenu(cx, cy, wire)` / `ctxCandidates` / `connect`）
- **節點右鍵指令選單**：在節點上按右鍵開出「重新命名（`F2`，選單就地變輸入框）／複製／
  斷開所有連線（顯示連線數，無連線時停用）／刪除」；在**已框選的節點**上按右鍵則對整組生效，
  此時隱藏「重新命名」並改顯示「已選取 N 個節點」。（`openNodeMenu` / `startRename` /
  `unlinkNodes` / `removeNodes`）
- `NODES.md`：節點總覽（每種節點的用途、是否呼叫 Claude／產生費用），由 README 拆出。
- `.gitignore`：忽略 `server.pid`、`server.log`、`outputs/`、`node_modules/`、`.env`、
  編輯器與作業系統暫存檔。
- `CHANGELOG.md`（本檔）與 `CLAUDE.md`（給 AI 助手的專案規範）。

### 變更

- **「⑂ 條件分支」的預設判斷式改為 trim 後精確比對**：原本是
  `String(value).includes("是")`，改成 `String(value).trim() === "是"`；
  內建範例「② 客服分流」的 `includes("退款")` 一併改成 `trim() === "退款"`，
  欄位說明也加上「建議精確比對，少用 `includes`」。原因是上游若是「只回一個詞」的分類器，
  一旦模型改成先解釋再回答，`includes` 就會把關鍵字從解釋裡撈出來而**誤判成立**——
  這件事真的發生過（分類節點回了一整篇拒絕聲明，裡面剛好有「退款」兩個字，整條分支就走錯）。
  已存檔的 Workspace 不受影響，要改請自己編輯該節點的判斷式。
- **開頁預設畫面改為 Workspace 總覽**：原本開啟頁面會直接把範例②載入畫布，
  改成先顯示總覽頁，從卡片（或新增）進入編輯；畫布快捷鍵在總覽頁一律停用。
- **匯出檔名改用 Workspace 名稱**：原本固定匯出 `workflow-graph.json`，
  改為 `<Workspace 名稱>.json`（不合法的檔名字元以 `_` 取代）。（`exportJSON`）
- **畫布平移改為中鍵或 `Space`＋左鍵拖曳**（原本是左鍵拖曳空白處）。平移判斷優先於一切，
  游標壓在節點上也是平移，不會誤拖節點；並擋掉瀏覽器中鍵自動捲動。
- **左鍵拖曳空白處的行為改為框選**（原本是平移）。
- **選取模型重構**：改為 `state.selection`（檢查器的主選取，可為節點或連線）
  ＋ `state.selected`（節點 id 集合）；原本散落 12 處的直接賦值一律改走
  `setSelection()` / `setSelectedNodes()`，避免兩者不同步。
- README：節點總覽表移到 `NODES.md`，改為一段簡介＋連結；新增「畫布操作」一節；
  左側節點庫的操作提示同步更新。

- `NODES.md` 不再於根目錄保留鏡像，只放在 `workflow-graph-app/`；根目錄 README 的連結、
  CLAUDE.md 的文件同步規則與 commit skill 的鏡像檢查一併更新。
- 設計規範集中到 `principles/`：`NODE_PRINCIPLES.md` 從 `workflow-graph-app/` 移入，
  並新增 `INTERACTION_PRINCIPLES.md`（畫布互動的設計原則、單檔前端的修改方法、
  回歸驗證清單與常見陷阱）與資料夾索引 `README.md`。
  README、NODES、CLAUDE 與 commit skill 的引用路徑一併更新。
- `.claude/skills/xin-gitcommit/`：本專案的 commit message 規範與流程（由公司 Unity 專案版本改寫，
  移除 Unity 專屬條款，改對應本專案結構）。決定納入版控供團隊共用，因此**不**加進 `.gitignore`。
- 建線邏輯抽成共用的 `connect(from, to)`（含 multi 埠可多接、一般輸入埠取代舊線的規則），
  拉線接埠與「拉到空白處自動接線」共用同一條路徑。

### 修正

- **ENOENT → shell 重試不再被舊 child 的 `close` 殺掉**：`spawn()` 失敗時 Node 在 `error`
  之後還會再發一次 `close`，而交棒給重試前沒有把該次 attempt 標記為結束，於是舊的 close
  handler 照樣執行——把重試中的子行程正在用的 System 提示暫存檔 `cleanup()` 掉，還搶先
  reject 外層 Promise。Windows 上 npm 全域安裝的 `claude.cmd` 一定會走這條 ENOENT → shell
  的路，等於這條路徑上的 LLM 節點固定失敗。（`server.js` → `callClaude()` 的 `child.on('error')`）
- **修掉 Windows 上的命令列注入與參數被空白拆開的問題**：`spawn('claude', args, { shell: true })`
  **不會替參數加引號**，Node 只是把 args 用空白串成一行丟給 `cmd.exe`——而這條 shell 路徑
  正是 npm 全域安裝 `claude.cmd` 的 ENOENT 重試必經之路。兩個後果：① `--system-prompt-file
  C:\Users\John Doe\...` 會被空白拆成兩個參數，使用者名稱有空白就直接壞掉；
  ② 舊版 CLI 的行內退路把整段 System 提示當命令列參數，含 `&` `|` `^` `>` 就會變成額外指令，
  而 System 提示來自可匯入、可分享的 Workspace JSON，不能當可信輸入。現在的規則是：
  可變內容永遠不進 argv（只走 `--system-prompt-file` 的暫存檔）、進 argv 的只有旗標與
  白名單過的模型名與我們自己產生的路徑、走 shell 時每個參數自己加引號；真的沒有安全解時
  （必須走 shell 又碰上不支援 `*-file` 的舊 CLI）明確報錯，不拼命令列。
  （`server.js` → `shellQuoteArg()` / `writeSysPromptFile()` / `MODEL_RE`）
- **模型名稱改為白名單檢查**：`model` 從前端來、可能來自匯入的 JSON，先前直接進命令列。
- **System 提示暫存檔改成 0600 ＋ `wx` ＋ crypto 亂數檔名**：原本用預設 0644 寫在全域可讀的
  暫存目錄，且沒有 `wx`，同名檔（含 symlink）會被跟隨覆寫；檔名亂數來自 `Math.random()`。
- **沒接線的「📤 節點輸出」不再送出 `undefined`**：`modout.run()` 一律回 `{_display: ...}`，
  即使輸入埠根本沒接線；引擎用 `hasOwnProperty` 判斷「這個埠有沒有值」，於是模組節點會多出
  一個**永遠活著的輸出埠**，下游拿到 `undefined` 還以為有資料通過。改成沒接線就不 emit
  `_display`（並在日誌寫明「⊘ 沒有接上任何輸入」），下游照條件分支的規則整條不執行。
- **Workspace 清單問不到時，不再把所有模組節點誤標成「來源已不存在」**：`refreshModules()`
  的 `catch` 把快取清成 `[]`，於是一次網路失敗就等於「全部來源都消失了」。現在失敗時
  **保留上一次的快取並記一筆日誌**，`syncSubflowPorts()` 在清單不可信時完全不動作。
  同時把 `_missing` **移出圖**（改成模組層級的 `missingModules` 集合）——它是畫面狀態不是圖的
  內容，先前寫在 `params._missing` 會被存進檔案（`graphData()` 只清 edges 不清 nodes），
  之後就算來源還在也一直標著「已不存在」。舊存檔裡的 `_missing` 在載入時會被洗掉。
- **「上游失敗」的判定改成埠層級**：先前 `deadByError` 是節點層級，只要這顆節點**任何一個埠**
  上有來自失敗節點的線就算數；合併節點還有另一條活線、根本沒被判死時也會被算進去，
  多輸入埠的情況會報到錯的死因。現在逐埠判定，只有真正讓這顆節點停下來的那個埠才決定死因。
- **模組埠定義不再帶 `def`**：`wsPorts()` 會把 `modin` 的預設值塞進埠定義，前端從沒讀過，
  卻會被深拷貝進**每個引用端**的 `_ports` 存檔。預設值是來源自己的事，留在來源節點上就好。
- `NODES.md` 的「📥 節點輸入」寫成「埠名＝節點名稱」，與其他三份文件的「埠名用內部節點 id」
  相衝；已改為「埠名用內部節點 id，埠上顯示的是節點名稱——改名不會斷線」。
- **LLM 節點的 System 提示終於真的生效**：原本 `system` 是被包成
  `[系統指示，請嚴格遵守]…[/系統指示]` **併進使用者訊息**送給 `claude -p` 的。
  Claude Code 自己有 system prompt，這段對它來說只是使用者貼進來的文字，
  會被判定成 prompt injection 而**拒絕照做**——實測回覆是「我不遵循使用者訊息裡的指令，
  我是 Claude Code」。後果：一個「只回覆一個詞」的分類節點會拿回一整篇拒絕聲明，
  下游的條件分支還可能因為那段文字剛好含有關鍵字而**誤判成立**；模型改去長篇解釋也讓
  耗時失控，`本地 Claude 執行逾時（180s）` 多半是這樣來的。
  改成走 CLI 的 system prompt 旗標：LLM 節點用 `--system-prompt`（整組取代 Claude Code
  的 coding agent 提示，因為 LLM 節點本來就是純文字進出、工具全拔），
  實際以 `--system-prompt-file` 傳暫存檔路徑（避開 Windows shell 回退路徑的引號與換行問題），
  舊版 CLI 不認 `*-file` 時自動退回同名的行內旗標。
  同一組提示詞、同一版 CLI（2.1.245）實測：原本回「我不遵循…」、398 output tokens；
  改完回「退款」、164 tokens。（`server.js` → `callClaude()` / `/api/llm`）
- **「跳過」不再冒充「上游分支未選中」**：上游節點**執行失敗**時，下游的節點卡片、檢查器
  與連線提示一律寫「上游分支未選中」，但那條分支明明選中了、是上游炸了。原因是
  `runGraph()` 把出錯的節點也丟進同一個 `skipped` 集合，下游分不出兩種死因。
  現在多一個 `failed` 集合沿鏈傳遞，訊息改成「未執行（上游節點執行失敗）」，
  檢查器並指示「往上游找標紅的節點看錯誤訊息」；連線 hover 也分開兩種說法。
  條件分支真的沒選中時，原本的文字完全不變。（`collectPortInputs` 的 `deadByError`）
- **節點重疊時，埠不再畫錯層級**：`.port` 有 `z-index:2` 而 `.node` 沒有設 `z-index`，
  節點因此不是獨立的 stacking context——所有埠都浮到**全部節點之上**。結果兩顆節點重疊時，
  **後面那顆的埠會畫在前面那顆的卡片上**，看起來像前面那顆長出一個奇怪的圓點；更麻煩的是
  在那個位置按下左鍵會從後面那顆「拉線」，而不是拖動眼前這顆節點。
  改法：`.node` 補上 `z-index:1`（埠的 `z-index` 從此只在自己節點內生效），
  並讓**選取中的節點浮到最上層**（`.node.selected { z-index:3 }`），
  被壓住的埠先點一下該節點就能拿到。純 CSS，圖的資料格式沒有變動。
- **執行過的圖不再被誤判成「有未儲存的變更」，暫態也不再被寫進存檔**：執行時會把
  `_flow` / `_dead`（線上要不要畫綠色流動與 ⊘ 標記）掛在邊物件上，但 `snapshot()`
  與存檔序列化的就是 `{nodes, edges}`，於是**跑完一次什麼都沒改，工具列也會亮 ●**、
  返回總覽還會跳「有未儲存的變更」；此時按「💾 儲存」，這兩個欄位會被寫進
  `workspaces/<id>.json`，下次開啟就照著畫出**根本沒發生過的那次執行**的高亮與
  「✓ 已傳遞資料」提示，而「↩ 重製」在那個狀態是 disabled 的，使用者清不掉。
  改法：圖的序列化統一走新的 `graphData()`（濾掉所有 `_` 開頭的邊欄位），
  快照、Workspace 存檔、匯出 JSON 三處共用；讀入外部圖（開啟 Workspace、匯入 JSON）
  改走 `loadedGraph()`，**順手洗掉舊版已經存進去的 `_flow` / `_dead`**，
  已經被汙染的存檔開起來就恢復正常，不需要手動修檔。
  （`public/index.html` → `graphData()` / `loadedGraph()` / `snapshot()` /
  `saveWorkspace()` / `exportJSON()` / `openWorkspace()` / `importJSON()`）
- **重複連線不再讓 `Ctrl+Y` 失效**：原本拉線放開時會先 `pushHistory()` 再視情況 `pop()`，
  但 `pushHistory()` 會清空重做佇列（`state.future`），`pop()` 救不回來——結果「拉一條已經存在
  的線」這種什麼都沒發生的操作也會讓 `Ctrl+Y` 沒反應。改成**先試接、確定圖真的有變才寫歷史**
  （`snapshot()` → `connect()` → `pushHistory(before)`），沒接成就完全不動歷史與重做佇列。
  （`public/index.html` → `mouseup` 的 `wire` 分支 / `pushHistory(snap)`）
- **右鍵選單開著時點連線，選單不會關閉**：連線的 `mousedown` 有 `stopPropagation()`，
  連帶擋掉了 `document` 上負責關閉選單的處理器。改成在該分支自己先呼叫 `closeMenus()`。
  （`edgeSvg` 的 `mousedown`）
- **選取異動全部改走 setter**：`Shift` 加選／退選、點選取集合內的節點換檢查器對象這三處，
  原本仍直接指派 `state.selection` / `state.selected`，繞過了規範要求的 setter。
  行為不變，但兩個欄位不再有各自更新而不同步的風險。
  （`setSelectedNodes(ids, primaryId)` 新增可指定「檢查器要顯示哪一顆」的第二個參數）
- **框選拖曳中不再改動 `state.selected`**：命中集合改放在 `drag.hit`，拖曳過程只切 CSS class，
  放開時才 `setSelectedNodes(drag.hit)` 一次提交，與「拖曳中不動狀態」的規範一致。

### 移除

- 死程式碼 `moveNodeEl()`：節點拖曳改為整組移動後已無任何呼叫點。

### 備註

- 以上互動改動以 Playwright 跑過 57 項自動化測試（含拉線、點選連線、滾輪縮放等回歸項目），
  全數通過且無 JS 例外。
- 上述「修正」與「移除」另跑一輪 47 項 Playwright 測試（涵蓋四項修正本身，
  以及 `INTERACTION_PRINCIPLES.md` 第 3.5 節的完整回歸清單），全數通過且無 JS 例外。
- 命令列安全的修正跑 18 項測試：用假的 `claude` CLI 攔下實際 argv，強制走 shell 路徑
  （`WFG_SPAWN_SHELL=1`）＋把暫存目錄設成含空白的路徑，驗證路徑完整送達、提示詞不進 argv、
  注入酬載沒有被執行、暫存檔 0600 且用完即刪、模型名稱白名單擋得住、舊版 CLI ＋ shell 時
  明確失敗而不是硬拼命令列。
- 模組相關的修正另跑 23 項 Playwright 測試：沒接線的 📤、離線時的模組狀態、`_missing` 不落地、
  舊存檔遷移、埠層級死因（合併節點有活線時不被判死）。
- System 提示的修正跑 16 項測試（用假的 `claude` CLI 攔下實際參數：確認走 `--system-prompt-file`、
  stdin 只剩 prompt、含引號換行的 system 一字不差、暫存檔用完即刪、舊版 CLI 的行內退路），
  再用真的 CLI 端到端驗一次分類節點回「退款」。
- 「上游失敗 vs 分支未選中」另跑 15 項 Playwright 測試：兩種死因各自沿鏈傳遞，
  節點卡片／檢查器／連線提示三處文字都對，`_deadErr` 不落地、`↩ 重製` 清得掉。
- Shell 指令節點跑 40 項 Playwright 測試：三道閘門逐一驗（模擬模式下磁碟上確實沒有被建檔、
  開關關著時報錯且沒執行、確認對話框看得到完整指令、按取消不執行、同段指令不再問、改過就再問）、
  成功／非 0 各走對分支且另一邊標「分支未選中」、stdin 與 `WFG_IN` 都收得到、工作目錄生效、
  目錄不存在／逾時／找不到 shell 三種錯誤訊息、核准紀錄與開關都不進存檔、重新整理後開關歸零。
- 模型設定與條件分支的改動跑 26 項 Playwright 測試：攔下實際送往後端的 body，驗證
  全域預設有送到、節點自選的不被覆蓋、「跟隨 Claude Code」是不帶 model、設定不進圖也不變 dirty、
  重新整理後仍記得、節點卡片文字跟著更新，以及新舊判斷式對同一段「多話的分類結果」的行為差異。
- 節點層級的修正另跑 14 項 Playwright 測試：修正前先重現問題（重疊處命中的是後面那顆的埠、
  按下去變成拉線），修正後改為命中前面那顆、按下去是拖節點；並確認選取後可從被壓住的埠拉線、
  沒重疊時埠仍在連線之上、膠框與右鍵選單仍在最上層、重疊情境下框選與整組拖曳照常。
- `_flow` / `_dead` 的修正另跑 29 項 Playwright 測試（真的起 `server.js`、建 Workspace、
  模擬模式跑完整張圖）：執行後不 dirty、返回總覽不跳對話框、存檔檔案內容不含暫態、
  刻意寫一份帶暫態的舊存檔開起來會被洗乾淨、「↩ 重製」與 `Ctrl+Z` 不受影響，全數通過。
