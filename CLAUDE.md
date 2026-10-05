# WorkFlowGraph — 專案規範

節點式 AI 工作流編輯器。伺服器零依賴（只用 Node 內建模組），前端是單一檔案
`workflow-graph-app/public/index.html`（畫布、執行引擎、檢查器全在裡面）。

## 動手前必讀

- 新增或修改**節點**前，先讀 `principles/NODE_PRINCIPLES.md`（核心原則、埠與連線語意、
  相容性義務、交付前 Checklist）。
- **有「新增節點」的需求時，預設做法是新增 FlowMap，不是新增節點型別。**
  先用現有節點在 FlowMap 裡把功能組出來，以 📥 節點輸入／📤 節點輸出 標好介面，
  **發布成模組**給別的 FlowMap 引用；只有組不出來時才考慮動 `NodeTypes`。
  節點庫（`NodeTypes`）**只放與領域無關的通用能力**——特定專案／部門／業務的流程一律做成模組，
  不進全域註冊表。
- 真的要加節點型別，必須先過「內建 vs 模組」三題且全部 yes（`NODE_PRINCIPLES.md` 一之 5）：
  通用嗎？用現有節點組不出來嗎？是原語而不是一串政策嗎？任一題沒過就回頭做 FlowMap，
  並在回覆裡說明為什麼不做成節點。
- 改**畫布操作模式**（滑鼠／鍵盤行為、選取、選單）前，先讀
  `principles/INTERACTION_PRINCIPLES.md`（輸入分派優先序、拖曳狀態機、選取模型不變式、
  單檔前端的安全修改流程與回歸清單）。
- 設計規範一律放在 `principles/`；新增規範時同時更新該資料夾的 `README.md` 索引。
- 節點的功能總覽在 `workflow-graph-app/NODES.md`；使用說明在 `README.md`。

## 每次改動都要更新 CHANGELOG

**任何會被使用者感知的改動（功能、操作方式、輸出格式、修正、移除）完成後，
一律在 `CHANGELOG.md` 補上紀錄，這是交付的一部分，不是可選項。**

- 位置：專案根目錄 `CHANGELOG.md`，**依日期由新到舊**排列，不維護版本號。
- 同一天的改動併入同一個 `## YYYY-MM-DD` 區塊，分類到「新增 / 變更 / 修正 / 移除」。
- 用使用者看得懂的話描述**行為**，必要時在括號補上關鍵檔案或函式名，方便回溯。
- 純內部重構若不影響行為，可略；但**操作方式或預設行為的改變一定要寫**，
  並明確寫出「原本是什麼、改成什麼」。

## Git 操作規則

- **Commit message 一律依照 `.claude/skills/xin-gitcommit/`**（規範見該資料夾的
  `COMMIT_CONVENTION.md`，流程見 `SKILL.md`）撰寫，不得自創格式。
- **未經 Justin 明確指示，禁止任何上傳動作。** 包含但不限於：`git push`（含 `--force`、
  推 tag、推新分支）、`git remote` 的任何寫入操作、建立或合併 Merge Request、
  以及任何會把內容送到 GitLab 的行為。
- 「幫我 commit」**不等於**「幫我 push」。要 push 必須有一句明確的上傳指示，
  沒有就只做到本地 commit 為止，並回報「已 commit，尚未 push」。
- 不確定算不算上傳時，一律當作是，先問再說。
- push 被保護分支或 hook 擋下時，回報並建議請 Maintainer 開權限或改推非保護分支開 MR；
  **不繞過、不 force、不改分支保護設定**。

## 文件同步

- `README.md` 在**根目錄與 `workflow-graph-app/` 各有一份且內容相同**，改其中一份後要把
  另一份一起更新（以 `workflow-graph-app/` 的為主、複製到根目錄）。唯一容許的差異是指向
  `NODES.md` 的連結：根目錄版寫 `./workflow-graph-app/NODES.md`，app 版寫 `./NODES.md`。
- `NODES.md` **只放在 `workflow-graph-app/`**，根目錄不再保留鏡像。
- `CHANGELOG.md`、`CLAUDE.md`、`.gitignore` 只放在根目錄，不要複製。

## 其他慣例

- 前端不引入建置流程與外部套件；伺服器端不新增 npm 相依。
- 破壞性的圖格式變更必須附上匯入遷移（見 `principles/NODE_PRINCIPLES.md` 的相容性義務）。
- 執行期產物（`server.pid`、`server.log`、`outputs/`）不進版控。
