# 設計規範

動手改這個專案之前先讀對應的那一份。

| 文件 | 何時必讀 |
|---|---|
| [`NODE_PRINCIPLES.md`](./NODE_PRINCIPLES.md) | 新增或修改**節點**：核心原則、埠與連線語意、相容性義務、交付前 Checklist |
| [`INTERACTION_PRINCIPLES.md`](./INTERACTION_PRINCIPLES.md) | 改**畫布操作模式**：輸入分派優先序、拖曳狀態機、選取模型不變式、單檔前端的安全修改流程與驗證清單 |

兩份都採同樣的結構：**原則**（為什麼這樣設計）→ **方法**（怎麼改才安全）→
**Checklist**（交付前逐項核對）。發現新的陷阱或推翻既有原則時，回頭更新對應的文件。

專案層級的規範（文件同步、CHANGELOG 義務、Git 操作規則）在根目錄的 `CLAUDE.md`。
