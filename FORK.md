# 這個 fork 的維護說明

這個倉庫是 [iib0011/omni-tools](https://github.com/iib0011/omni-tools) 的 fork，額外加了兩個東西，而且**設計成上游更新時不會被蓋掉**：

| 項目 | 內容 | 放在哪裡 |
|---|---|---|
| 繁體中文（`zh-TW`） | 全部 1,792 條介面字串，使用台灣慣用詞彙 | `public/locales/zh-TW/`（全是新檔案，上游不會動到） |
| 同步上游 + 安全檢查 | 手動一鍵同步，並自動檢查這次上游帶進來什麼 | `.github/workflows/sync-upstream.yml`、`.github/workflows/zh-tw-check.yml`、`scripts/fork/` |

**唯一動到上游原有檔案的地方只有兩處，各 1 行**（把 `zh-TW` 加進語言清單）：

- `src/i18n/index.ts`：`supportedLngs` 多一行 `'zh-TW'`
- `src/components/Navbar/index.tsx`：語言選單多一行 `{ code: 'zh-TW', label: '繁體中文' }`

其餘全部是新增檔案，所以合併上游時幾乎不會衝突。

---

## 第一次使用前（只要做一次，全部在 GitHub 網頁上）

1. 到 **Settings → Actions → General → Workflow permissions**：
   - 選 **Read and write permissions**
   - 勾選 **Allow GitHub Actions to create and approve pull requests**
   - 按 Save
2. （選用）如果上游改了 `.github/workflows`，內建的 token 沒有權限推送這類變更。到時請建立一個 fine-grained personal access token（只授權這個倉庫，Contents / Pull requests / Workflows 皆為 Read and write），存到 **Settings → Secrets and variables → Actions** 的 `SYNC_TOKEN`。沒設也沒關係，只有那種情況才會用到。

## 每次要同步上游

1. **Actions → 同步上游（手動）→ Run workflow**
2. 等一兩分鐘，**Pull requests** 會出現「同步上游」的 PR，內文有：
   - 能不能自動合併（有衝突會列出檔案）
   - 🔒 安全檢查報告（🟢 低／🟡 中／🔴 高）
   - 🈶 繁體中文還缺哪些翻譯
3. 看過報告、沒問題就按 **Merge pull request**。
4. 如果報告說有缺翻譯，再到 `public/locales/zh-TW/` 補（在倉庫頁按鍵盤的 `.` 會開網頁版編輯器）。沒補也不會壞，沒翻的字串會先顯示英文。

> 如果「已經是最新」，workflow 會直接告訴你，不會建立任何東西。

### 遇到衝突怎麼辦
通常只會是 `src/i18n/index.ts` 或 `Navbar`：上游剛好也改了語言清單。在 PR 頁面按 **Resolve conflicts**，**兩邊都保留**，確認清單裡還有 `'zh-TW'` 即可。

---

## 安全檢查在看什麼

只看「這次上游比你多的變動」，而且**絕不執行上游的任何程式碼**（只用 `git show` / `git diff` 讀取；不 `npm install`，所以不會觸發安裝腳本）。檢查腳本永遠來自你自己的分支。

🔴 需要親眼確認：
- `.github/workflows` 被改動（會停下來，見下）
- 依賴改成指向 git／網址／本機路徑，或 `postinstall` 等安裝腳本被改
- `package-lock.json` 裡有套件不是從 npm registry 下載
- 新增的程式碼含 `eval`、`new Function`、`curl | sh`、外部 `<script>`
- 疑似洩漏的金鑰、新增可執行檔／腳本
- `npm audit` 在這次更新中新增了高風險以上的漏洞

🟡 提醒：新增依賴與有安裝腳本的套件、`Dockerfile`／`vite.config`／`index.html` 變動、新的對外網域、對外網路請求、未固定 SHA 的第三方 Action……

**如果上游改了 `.github/workflows`**，同步會先停下來、不建立任何分支，讓你先看 Summary 裡的 diff。確認安全後，重新執行並勾選 **allow_workflow_changes**。這是刻意的：workflow 能讀取你的 secrets 並執行任意指令。

### 它做不到的事
這是降低風險的輔助工具，**不是保證**。它抓的是常見的可疑線索；沒被列出不代表一定沒問題。重點項目（workflow、依賴、安裝腳本）請務必親自看過。

---

## 疑難排解

| 狀況 | 處理 |
|---|---|
| 同步分支已推送，但沒有自動建立 PR | 第一次設定的第 1 步沒勾「Allow GitHub Actions to create…」。勾選後重跑，或點 Summary 裡的連結手動建立 |
| 推送失敗、訊息提到 workflow 權限 | 依「第一次使用前」第 2 步設定 `SYNC_TOKEN` |
| 「同步分支上有尚未合併、不屬於上游的 commit」 | 你在網頁上解過衝突、但那個 PR 還沒合併。請先合併或關閉它，並刪除 `upstream-sync` 分支，再重跑 |
| 上游的 `ci.yml` 在你的 fork 上跑失敗 | 上游的 CI 會部署到 Docker Hub／Netlify，需要你沒有的 secrets。可在 **Actions** 頁面停用那個 workflow |
| 想在本機／網頁編輯器檢查翻譯 | `node scripts/fork/i18n-check.mjs`（需要 Node 18+，不需要安裝任何套件） |

## 已知限制
- 沒有「繁體中文」專屬的 Crontab 說明與數字轉文字：這兩個工具會依語言代碼挑函式庫語系，`zh-TW` 目前會退回英文。介面其餘部分都是繁體中文。
- 瀏覽器語言為 `zh-HK`、`zh-Hant` 等時，會落到專案原本的簡體 `zh`；只有 `zh-TW` 會自動選到繁體。可以從右上角語言選單手動切換。
