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

## 之後搬到 Cloudflare Pages

登入與播放器程式仍可沿用，不需要重寫整個網站。Cloudflare Pages 支援直接部署靜態 HTML：

1. 在 **Workers & Pages → Create application → Pages** 匯入這個 GitHub 程式庫。
2. Production branch 選擇 `main`，Framework preset 選擇 `None`。
3. Build command 使用 `exit 0`；Build output directory 使用 `.`（網站位於程式庫根目錄）。
4. 先確認直播與聊天室正常，再替正式網址及預覽網址配置 Cloudflare Access。
5. 若要真正私人使用，停用公開的 GitHub Pages，並另外處理公開程式庫與歷史頁面的可見性。

新增的登入資源使用相對路徑，同時支援 GitHub 的 `/tv/` 子路徑與 Cloudflare 的根網址。原有直播台仍依賴原作者提供的頻道清單、代理、聊天室與 Firebase；搬移時需要逐一確認這些外部來源仍可用，或改成自己的來源。Twitch 的 `parent` 已依目前網域產生。

官方文件：[Static HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)、[Preview deployments / Access](https://developers.cloudflare.com/pages/configuration/preview-deployments/)。
