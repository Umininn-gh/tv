# Userscript 1.0.16 瀏覽器回歸驗證

基準：`9e6265e9f89ce847970ce83a7aae0cea90ecc1fa`。此變更只增加測試與 CI，沒有修改播放器或發佈新的 Userscript。

## 重複執行

使用 Node.js 22 或以上，從倉庫根目錄執行：

```sh
npm ci
npx --no-install playwright install --with-deps chromium firefox
npm run test:player-unit
npm run test:browser -- --repeat 2
```

只跑一種瀏覽器：

```sh
npm run test:browser -- --engine chromium --repeat 2
npm run test:browser -- --engine firefox --repeat 2
```

指令可直接在 PowerShell、cmd 或 bash 使用，不需要手動設定環境變數。Windows 安裝瀏覽器亦可用 `npx --no-install playwright install chromium firefox`。

Playwright 固定為 **1.56.1**，並提交 npm lockfile；其 Chromium 為 **141.0.7390.37**、Firefox 為 **142.0.1**。這是可重現的測試基線，**不是最新穩定版瀏覽器的相容性聲明**。更新 Playwright 與 lockfile 後需重新跑兩個引擎。CI 固定 Ubuntu 24.04、Node 22，Actions 亦固定 commit SHA。

## 沿用及補充的覆蓋範圍

| 風險 | 直接沿用的現有用例 | 本次補充 |
| --- | --- | --- |
| 放大後只開啟目標聲音 | `player-layout-browser.test.cjs` 的全部 `audio focus ` 用例：真正的放大控制、native／foreign／wrapped target、等待 mute ACK、失敗時保持目標靜音 | 統一納入兩引擎的必要回歸入口 |
| 延遲／過期 iframe | 現有回覆延遲、重建 document、舊 target 及舊 ACK 用例 | 真正攔住新 iframe 的 HTTP navigation；尚未建立連線時目標不得開聲，載入後加入靜音防護 |
| 平台重設聲音及媒體重建 | 現有 sound reset、有限重試、hidden audio、ad video replacement 用例 | 延遲 iframe 完成後再次自行開聲，也須被靜音 |
| 命令併發上限 | `player-extension-site-ui.test.cjs` 已用 40 個播放器確認最多 4 個同時執行的命令；transport 單元測試覆蓋容量與舊訊息 | 不重複建立相同模型 |
| 書籤恢復與音訊競態 | `player-extension-site-compatibility.test.cjs` 的 layout event、快速重複恢復、audio focus 取消 waiting recovery | 實際 `capturePlayerBookmark()`／`applyPlayerBookmark()` + built Userscript + 跨 origin ACK gate，驗證兩種先後次序；較新的放大取消恢復，較新的書籤只恢復每個暫停來源一次且沒有遲來開聲 |
| Userscript 接線與自動播放 | `player-userscript-browser.test.cjs` 全部用例 | 移除隱含 Edge fallback，Chromium job 使用真正的 Playwright Chromium |

網站相容性 suite 的 recovery/controller 使用替身；新書籤整合用例使用完整發佈的 Userscript、真實 HTMLMediaElement、真實跨 origin postMessage 和本地 WAV。原有相容性用例仍保留，用於檢查 production HTML 接線。

## 防止假成功

- `npm run test:browser` 主動設定 `UMININN_BROWSER_TESTS=1`；呼叫者漏設旗標也會執行。
- 直接以 `node --test` 執行舊有 suite 時仍須自行設定該旗標；未設定時仍會跳過。因此 CI 使用正式回歸入口。
- 正式入口先核對已安裝 Playwright 版本與 built Userscript 是否符合來源，然後在獨立程序試開一個真實頁面；20 秒內無法完成便失敗。
- 被要求執行的 Chromium／Firefox 無法啟動、用例失敗、TODO、非預期 skip、零測試或必要用例缺失，均回傳非零 exit code。
- 唯一允許的引擎 skip 是 Chromium 上那個名稱固定的 Firefox strict-autoplay 用例；Firefox 必須實際通過它。
- layout suite 只選 `^audio focus `。其他幾何、觸控、hover 用例不屬於這次回歸集，不宣稱已執行整個瀏覽器測試庫。
- 每輪完整執行，沒有「重試至成功」；任何一輪失敗，整個指令失敗。各引擎與 suite 順序執行以減少資源競爭。

結果位於 `test-results/browser/<engine>.json`，包含 commit、dirty flag、Userscript／Node／Playwright／瀏覽器版本、每輪逐項通過與 skip／失敗／缺失名稱。相鄰 `.jsonl` 保存 Node test runner 事件、錯誤與診斷。重新跑同一引擎會覆蓋該次結果。

## GitHub Actions

`.github/workflows/player-regression.yml` 在每個 PR、push 到 `main` 和手動執行時啟動；沒有路徑過濾。兩引擎 matrix 設 `fail-fast: false`，每個引擎執行兩輪，安裝 pinned browser 及系統依賴，最後即使失敗也上載結果（保存 14 天）。安裝失敗亦會令 job 失敗。

工作流程只要求 `contents: read`，使用攔截網絡的本地 fixture，無需帳密或 production secrets。推送 draft PR 也會觸發驗證，無需先合併。

若要阻止失敗版本被合併，倉庫維護者還需把以下 checks 設為 branch protection／ruleset 的 required checks：

- `Player unit tests`
- `Player browser (chromium)`
- `Player browser (firefox)`

加入 workflow 本身不會修改 branch protection；未要求 checks 的分支仍可合併失敗版本。

## 2026-10-22 實際驗證紀錄

- 基準相關單元測試先跑 150 項，全部通過。
- 完整相關單元回歸集（含回歸入口防漏測試）346 項，全部通過，0 skip。
- Chromium 首輪：Userscript 5 pass + 1 預期 Firefox-only skip；audio focus 23 pass；site compatibility 11 pass。
- 缺少瀏覽器的負向驗證：指定不存在的 executable，suite 回傳失敗，0 skip。
- 本機 Firefox 142.0.1 可啟動主程序，但建立頁面時 content process 報 `Sandbox: writing /proc/self/uid_map: EPERM` 並崩潰。首輪的前兩個用例逾時後已停止，不能視為功能測試結果。正式入口已增加獨立、限時的頁面 preflight，避免逐項等到逾時。
- Chromium 正式入口連續兩輪全部通過，每輪 39 pass、1 預期 Firefox-only skip，0 fail。這些數字包含 Node runner 計數的巢狀測試。
- Firefox 正式入口已實際在本機 20 秒 preflight 上限回傳失敗，沒有把未執行用例列為通過。

隨後在 GitHub hosted runner（Ubuntu 24.04、Node 22）實際執行 [Actions run 39696232403](https://github.com/Umininn-gh/tv/actions/runs/39696232403)，測試 commit `60055d56f0d62e3d5d91c9632501226c909ce20d`，三個 jobs 全部成功：

| 驗證 | 第一輪 | 第二輪 | 結果 |
| --- | --- | --- | --- |
| Chromium 141.0.7390.37 | 39 pass、1 預期 Firefox-only skip | 39 pass、1 預期 Firefox-only skip | 通過，0 fail |
| Firefox 142.0.1 | 40 pass、0 skip | 40 pass、0 skip | 通過，0 fail |
| 相關單元測試 | 346 pass、0 skip | 不重複執行 | 通過，0 fail |

每輪 browser 數目為 Userscript 5／6 + audio focus 23 + site compatibility 11；包含 Node runner 的巢狀用例計數。Firefox strict-autoplay 用例已在 CI 兩輪實際通過。兩引擎預設 autoplay 觀察均為 native／foreign 放大目標 `muted=false, paused=false, volume=1`；既有斷言亦確認音訊選擇沒有呼叫 play／recover、seek、load 或替換來源。

這次 hosted Firefox 成功與本機 `uid_map` 錯誤的差異支持「本機執行環境限制」的判斷。CI 已上載兩個引擎的完整 JSON/JSONL 結果；保存期後可用上方指令重跑。後續 PR HEAD 狀態請查看 [PR #1 checks](https://github.com/Umininn-gh/tv/pull/1/checks)。

## 尚不涵蓋

本回歸是 headless、本地網絡 fixture 驗證；沒有安裝 Tampermonkey／Violentmonkey、沒有連接真實 Twitch／Kick／AngelThump 串流、登入或廣告系統，也沒有驗證 Windows、手機、實際音訊輸出或所有瀏覽器版本。主頁只載入既有 fixture 選取的 production 區段，而非完整登入及遠端服務流程。通過不等於上述環境已完成端到端驗證。

CI 寫法參考 [Playwright CI 文件](https://playwright.dev/docs/ci) 與 [GitHub matrix 文件](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)。
