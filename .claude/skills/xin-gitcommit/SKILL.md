---
name: xin-gitcommit
description: >-
  依照 WorkFlowGraph 專案的 Git commit 規範，協助撰寫、確認並執行 commit（與可選的 push）。
  Use when the user wants to commit changes, write a commit message, git commit,
  寫 commit、提交、commit message、推版、push。
---

# Git Commit 助手（xin-gitcommit）

依照 [COMMIT_CONVENTION.md](COMMIT_CONVENTION.md) 為本專案產生符合規範的 commit message，
並依使用者需求執行 commit / push。

**本專案結構**（影響 stage 範圍歸群與模組分離判斷）：

```
workflowgraph/
├─ CHANGELOG.md / CLAUDE.md / README.md   # 文件（README 根目錄與 app 各一份鏡像）
└─ workflow-graph-app/
   ├─ public/index.html    # 前端全部（畫布、引擎、檢查器）都在這一個檔案
   ├─ server.js            # 零依賴 Node 伺服器：Claude 橋接 + 檔案 API
   ├─ scripts/ctl.js       # stop / restart 控制腳本
   └─ samples/             # 範例資料
```

---

## 模式說明

| 模式 | 觸發方式 | 行為 |
|------|----------|------|
| **草稿模式** | 只要求寫 commit msg | 產出草稿供使用者自行執行，不執行任何 git 指令 |
| **半自動模式** | 要求「幫我 commit」 | 顯示草稿 → 使用者確認 → 執行 `git commit`，不 push |
| **全自動模式** | 要求「幫我 commit 並 push」 | 顯示草稿 → 使用者確認 → 執行 `git commit` + `git push` |

> ⚠️ **全自動模式強制確認**：不論使用者說「直接做」或「不用問我」，
> commit message 草稿**一定要讓使用者看到並明確批准後**才能執行 commit 與 push。
> Push 是對共用遠端的不可逆操作，禁止跳過確認步驟。

> ℹ️ 本專案的 `main` 是 GitLab 保護分支。push 被 `pre-receive hook declined` 擋下時，
> **不要嘗試繞過**（不改分支保護、不 force、不換帳號）；直接回報錯誤並建議：
> 請 Maintainer 開權限，或先推到非保護分支再開 MR。

---

## 執行流程

### Step 1 — 確認 Staging 範圍

先執行 `git status` 與 `git diff --cached --name-only` 取得目前狀態，再依以下情況處理：

**情況 A：使用者在指令中已指定檔案或路徑**
（例如：`/xin-gitcommit workflow-graph-app/public/`）

- 僅對指定範圍執行 `git add <paths>`，其他異動檔案保持原狀
- 執行前列出將要 stage 的檔案清單，讓使用者確認

**情況 B：目前已有 staged 變更（且使用者未另外指定）**

- 直接使用現有 staged 內容，不額外 `git add`
- 顯示已 staged 的檔案清單供使用者確認範圍正確

**情況 C：無任何 staged 變更，使用者也未指定檔案**

> ⛔ **強制暫停**：此情況下**禁止自行執行任何 `git add`**，也**禁止繼續進行 Step 2 以後的流程**。
> 必須先列出檔案清單並等待使用者明確指定範圍，才能繼續。

執行步驟：
1. 執行 `git status` 列出所有 unstaged 異動檔案（含路徑與異動狀態）
2. 分析異動檔案，依上方專案結構歸群（前端 / 伺服器 / 腳本 / 文件），產出選項清單，
   格式如下（示意，實際路徑與數量依 `git status` 結果產生）：

   ```
   ⚠️ 目前沒有已 staged 的變更。請選擇要提交的範圍（可輸入多個編號，以空白分隔）：

   1. workflow-graph-app/public/（1 個檔案）
   2. workflow-graph-app/server.js（1 個檔案）
   3. 文件：README.md、workflow-graph-app/NODES.md、CHANGELOG.md（3 個檔案）
   4. 全部變更（git add -A，共 N 個檔案）
   5. 自行輸入路徑
   ```

   規則：
   - 每個有異動的獨立檔案 / 群組各列一個選項（路徑由 `git status` 實際結果決定，不可寫死）
   - 文件類（`*.md`）歸成同一個選項
   - 倒數第二個選項固定為「全部變更（git add -A）」
   - 最後一個選項固定為「自行輸入路徑」
   - **支援多選**：使用者可輸入多個編號（如 `1 3`），依序對各路徑執行 `git add`
   - 若同時選了「全部變更」與其他選項，以「全部變更」為準

3. **等待使用者回覆**，不得假設或自動選擇
4. 使用者回覆「全部」時，需再次確認後才執行 `git add -A`
5. 使用者指定路徑後，執行 `git add <paths>`，再顯示 staged 結果確認

收集完 staged 範圍後，再執行：

```bash
git diff --cached          # 已 stage 的完整 diff（用於分析 commit 內容）
git log --oneline -5       # 最近 5 筆 commit（用於對齊風格）
```

- 若使用者有提供 GitLab issue 編號，記下該數字，Footer 直接使用，無需重複追問。
- **編號只能來自使用者明確提供**，禁止從 diff 或分支名推導。

#### 模組分離判斷

分析 `git diff --cached` 是否橫跨多個區塊（前端 `public/` ／伺服器 `server.js` ／
腳本 `scripts/` ／文件 `*.md`）：

- 同一區塊，或**文件只是為了同一件事而同步更新**（例如改了畫布操作，順帶更新
  README 與 CHANGELOG）→ 視為同一件事，**不需拆分**
- 前端與伺服器同時有實質改動，且是兩件不相干的事 → 列出各自變更行數，
  詢問使用者要拆成兩個 commit 或合併提交

### Step 2 — 判斷 Type

依 COMMIT_CONVENTION.md 規則選出**唯一**一個 Type：

- 同時有 fix 與 feat → 優先用 `fix`
- **使用者操作方式、快捷鍵、預設行為的變更 → `feat` 或 `fix`**，不可歸到 `style` / `refactor` / `docs`
- 行為完全不變的整理 → `refactor`；純格式 → `style`
- 只動 `*.md` → `docs`；只動 `.gitignore`、開發腳本、目錄結構 → `chore`

### Step 3 — 撰寫 Subject

- 祈使句、50 字以內、不加句號、優先繁體中文
- 必須描述**實際改動內容**，不可只寫 issue 編號
- 建議以區塊開頭：`畫布，…` / `節點，…` / `伺服器，…` / `文件，…`

### Step 4 — 判斷 Body（選填）

需要 Body 的情況：
- 標題無法完整說明（多個改動點）
- **操作方式或預設行為有變更** → 必寫「原本是什麼 → 改成什麼」
- **有相容性影響**（舊工作流 JSON 的匯入遷移、埠名變更）→ 必須註明
- 需補充驗證方式（例如以 Playwright 跑過哪些互動測試）

每行 ≤ 72 字，多項用 `-` 或數字列點，描述行為而非逐行複述程式碼。

### Step 5 — 判斷 Footer（有 issue 編號時必填）

> ⛔ **Footer 規則為強制**：只要有 issue 編號，Footer 就必須存在，絕不可省略。

- 格式：`issue <編號>`，多個 issue 各占一行
- 編號**只能來自使用者明確提供**

### Step 6 — 提交前 Review（使用 Subagent）

基於 Step 1 收集的 diff 執行獨立 review：

- 啟動 subagent，僅傳遞客觀材料（staged file list、完整 diff）
- 不傳遞主執行緒對 Type/Subject 的判斷結論，避免引導

檢查項：

- **敏感資訊**：密碼、金鑰、token、私有憑證、本機絕對路徑
- **臨時程式碼**：`console.log` 除錯輸出、TODO 佔位、硬編碼測試資料
- **衝突與格式**：衝突標記、尾隨空格、縮排異常
- **提交範圍**：執行期產物（`server.log`、`server.pid`、`outputs/`）、
  `.claude/`、`node_modules/`、備份檔（`*.bak`）誤入
- **單檔前端的整段遺失**：`public/index.html` 是單一大檔，diff 動輒數百行。
  檢查是否有**非預期的整段刪除**（例如某個 `/* ---------- xxx ---------- */`
  區塊整段消失），這是本專案最容易發生的意外
- **文件鏡像一致**：若 `README.md` 有異動，確認根目錄與 `workflow-graph-app/` 兩份
  **內容相同且都已 stage**（僅指向 `NODES.md` 的連結路徑不同；見 CLAUDE.md 的文件同步規則）。
  `NODES.md` 只有 `workflow-graph-app/` 一份，不需要鏡像
- **CHANGELOG 是否已更新**：依 CLAUDE.md，使用者感知得到的改動必須在
  `CHANGELOG.md` 當日區塊留下紀錄。若 diff 有此類改動卻沒動到 CHANGELOG，
  視為**非阻塞風險**並在草稿中提示

處理邏輯：

- **無阻塞問題** → 繼續執行 Step 7
- **有阻塞問題** → 列出問題檔案位置與建議修復方式，暫停提交
- **有非阻塞風險** → 繼續 Step 7，但輸出草稿時一併提示風險

---

### Step 7 — 輸出草稿並確認

以下方模板呈現草稿，**等待使用者明確回覆「確認」或修改意見**：

```
────────────────────────────────
📝 Commit Message 草稿
────────────────────────────────
<Type>: <Subject>

<Body（若有）>

<Footer（若有）>
────────────────────────────────
模式：[草稿 / commit / commit + push]

請確認內容。若需調整請直接告知，確認後輸入「ok」或「確認」即可執行。
```

### Step 8 — 執行（半自動 / 全自動模式）

Step 7 使用者確認後：

1. **Commit**：
   ```bash
   git commit -m "$(cat <<'MSG'
   <Type>: <Subject>

   <Body>

   <Footer>
   MSG
   )"
   ```
   使用 heredoc 確保多行訊息格式正確，**禁止使用 `--no-verify`**。

2. **Push**（全自動模式）：

   Push 前先執行：
   ```bash
   git log @{u}..HEAD --oneline
   ```
   確認本地領先提交內容符合預期，避免誤推。

   確認後執行：
   ```bash
   git push
   ```

3. 回報執行結果（成功 commit hash / 失敗錯誤訊息）。
   若被保護分支擋下，依「模式說明」的提醒回報，不要嘗試繞過。

---

## 格式自我檢查清單

執行前確認 commit message 符合以下規則：

- [ ] Type 只有一個，來自規範表
- [ ] **操作方式／預設行為的變更沒有被歸到 `style`、`refactor` 或 `docs`**
- [ ] Subject ≤ 50 字，祈使句，不加句號，不只寫 issue 編號
- [ ] Body 與 Subject 之間有空行（若有 Body）
- [ ] **行為變更的 Body 有寫出「原本是什麼 → 改成什麼」**
- [ ] Footer 與 Body 之間有空行（若有 Footer）
- [ ] **有 issue 編號時 Footer 必填**，格式為 `issue XXXX`
- [ ] **issue 編號來自使用者提供**，沒有捏造或推測
- [ ] README 若有異動，兩份鏡像都已一起 stage
- [ ] 使用者感知得到的改動已寫進 CHANGELOG.md

---

## 邊界情況

| 情況 | 處理方式 |
|------|----------|
| 無 staged 變更且未指定檔案 | **強制暫停**：列出所有 unstaged 檔案，等待使用者明確指定範圍，禁止自行 stage |
| 使用者提供 issue 但未在 diff 中出現 | 仍加入 Footer，但標注「由使用者提供」 |
| Push 被保護分支 / hook 擋下 | 停止並回報，建議請 Maintainer 開權限或改推非保護分支開 MR，**不繞過、不 force** |
| Push 遠端需要驗證或 force-push | 停止並告知，不自動加 `--force` |
| Pre-commit hook 失敗 | 回報錯誤內容，不 amend，協助排查後重新 commit |
| 使用者要修改草稿 | 重新輸出修改後的草稿，再次等待確認 |
| Subagent review 發現阻塞問題 | 列出問題檔案位置與建議修復方式，暫停提交流程 |
| README 只改了其中一份 | 視為阻塞：提醒同步另一份後再提交 |
| 前端與伺服器是兩件不相干的事 | 列出各自行數，詢問是否拆成兩個 commit |
| `.git/index.lock` 殘留導致 git 指令失敗 | 確認沒有其他 git 程序後刪除該檔再重試 |

---

## 參考資源

- 完整規範：[COMMIT_CONVENTION.md](COMMIT_CONVENTION.md)
- 專案規範與文件同步規則：`CLAUDE.md`
- 設計規範：`principles/NODE_PRINCIPLES.md`、`principles/INTERACTION_PRINCIPLES.md`
