# 個人直播台

靜態 HTML / JavaScript 網站，可部署到 GitHub Pages 或 Cloudflare Pages。

## 首頁密碼登入

- 首頁顯示登入畫面，密碼正確後才載入播放器、聊天室及頻道清單。
- 同一分頁重新整理會保留登入狀態；按「登出」會清除狀態並重新載入。
- 密碼設定只保存 salt 和 SHA-256 雜湊，不包含明文密碼。
- 這是阻擋一般訪客的前端密碼閘，不是私人託管。其他 HTML 頁面、公開檔案、程式庫和歷史版本仍可直接讀取。

### 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 首頁樣式、登入表單、登入後才掛載的網站模板 |
| `login.js` | 密碼驗證、啟動網站、同分頁登入狀態及登出 |
| `login.css` | 桌面與手機登入畫面 |
| `login-config.js` | 密碼 salt、雜湊及登入狀態名稱 |
| `tv-app.js` | 原有直播台功能，改為登入後啟動 |
| `set-login-password.cjs` | 更新密碼設定的 Node.js 工具 |

### 更改密碼

在專案根目錄執行：

```sh
node set-login-password.cjs
```

依提示輸入新密碼。也可以產生新密碼：

```sh
node set-login-password.cjs --generate
```

產生的密碼只會顯示在執行工具的終端。提交並部署更新後的 `login-config.js`，現有登入狀態會失效。請用網站專用密碼。

## GitHub Pages

在專案的 **Settings → Pages → Build and deployment** 設定：

- Source：**Deploy from a branch**
- Branch：**main**
- Folder：**/(root)**

儲存並等待部署完成後，使用原有 `https://umininn-gh.github.io/tv/` 網址。

## 聊天室

首頁預設載入本程式庫的 `test3.html`，並以匿名模式接收 Twitch `whitewing940920` 的訊息。這與 [SK 雞友直播台](https://skknower.com/user/ctvhiki49713?ch=12) 的右側 SKChat 使用相同的 Twitch 頻道；貼圖、回覆圖示和本地資源清單改從本網站讀取，不依賴已關閉的 chicktv GitHub Pages。

頂欄的 TWITCH 切換仍可開啟同頻道的 Twitch 官方聊天室，並記住選擇。目前先修復觀看訊息；自訂聊天室的 Twitch 發言登入尚未重新設定或驗證。

即時收訊會逐則解析 Twitch IRC，支援短留言省略內容前冒號的合法格式，也避免同批收到多則留言或控制訊息時漏顯示。歷史與即時留言按時間排列、避免重複，並保留 Twitch 回覆與自訂引用；循環引用會顯示提示，格式轉換失敗則保留原文。文字中的 HTML 符號按原文字顯示，貼圖和媒體由程式另外產生。

初次開頁顯示最近最多 30 則歷史留言。每按一次「載入更早留言」，再加入最多 30 則較早留言。`test3.html` 的 `CHAT_HISTORY_BATCH_SIZE` 統一設定首次及每次載入數量；正常跟隨最新留言時，畫面和背景緩衝的保留上限由該數量乘以 10 得出，目前為 300 則。閱讀舊留言期間暫停移走內容，可以超過 300 則，亦可繼續每次載入 30 則舊留言。重新連線或回到分頁時最多補抓 800 筆，只補已看過時間之後的訊息，不會自動加入大量更早紀錄。能補回的內容仍取決於外部服務保存的紀錄，不能保證與 SKLive 完全相同。

向上捲動、載入更早留言或跳到引用留言時，停止追底並暫停移走舊留言，背景緩衝也會保留暫停期間的訊息。手動捲回最底可跟隨新留言，但不解除保留暫停，右下角箭嘴仍會顯示。只有按箭嘴回到最新後，才解除暫停、移走超出上限的較早留言，保留最近 300 則，並恢復後續移除。加入、補回及重繪留言時會維持當前閱讀位置，媒體載入也不會強制追底。重新整理頁面則從最近 30 則重新開始。

徽章與貼圖資源獨立載入並有逾時限制，不會阻擋歷史或即時留言。失效的 Twitch 登入資料會自動切回匿名觀看；重建連線時，舊連線的延遲事件不會中斷新連線。

## 之後搬到 Cloudflare Pages

登入與播放器程式仍可沿用，不需要重寫整個網站。Cloudflare Pages 支援直接部署靜態 HTML：

1. 在 **Workers & Pages → Create application → Pages** 匯入這個 GitHub 程式庫。
2. Production branch 選擇 `main`，Framework preset 選擇 `None`。
3. Build command 使用 `exit 0`；Build output directory 使用 `.`（網站位於程式庫根目錄）。
4. 先確認直播與聊天室正常，再替正式網址及預覽網址配置 Cloudflare Access。
5. 若要真正私人使用，停用公開的 GitHub Pages，並另外處理公開程式庫與歷史頁面的可見性。

新增的登入資源使用相對路徑，同時支援 GitHub 的 `/tv/` 子路徑與 Cloudflare 的根網址。原有直播台仍依賴原作者提供的頻道清單、代理、聊天室與 Firebase；搬移時需要逐一確認這些外部來源仍可用，或改成自己的來源。Twitch 的 `parent` 已依目前網域產生。

官方文件：[Static HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)、[Preview deployments / Access](https://developers.cloudflare.com/pages/configuration/preview-deployments/)。
