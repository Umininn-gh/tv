# Umininn TV 播放器控制 1.0.0：發佈及安裝

這份文件配合正式發佈用的 1.0.0 套件。套件已移除本機測試網址權限，可交到商店審核或 Mozilla 簽署；「建置完成」不代表已上架、已簽署或已取得正式安裝連結。

## 建置檔案

在程式庫根目錄執行，無須安裝 npm 套件：

```powershell
node tools/build-player-extension.cjs --release
```

輸出位於 `outputs/player-extension-release/`：

| 瀏覽器 | 送審檔案 | 用途 |
| --- | --- | --- |
| Chrome 109 或以上 | `chrome.zip` | 上傳 Chrome Web Store |
| Edge 109 或以上 | `edge.zip` | 上傳 Microsoft Edge Add-ons |
| Firefox 140 或以上 | `firefox.zip`／`firefox-unsigned.xpi` | 上傳 Mozilla AMO 審核或簽署；兩者均未簽署 |

各瀏覽器同名資料夾可供本機檢查。ZIP 根目錄包含 `manifest.json`；套件只收錄擴充功能所需檔案。表列版本是 manifest 載入門檻，實際安裝及直播相容性仍須驗證。

## 配合現有網站的調整

1.0.0 同步網站與擴充功能的「全體靜音／開聲」偏好，讓由單台轉多台、加入或移除播放器時，沿用目前的全體聲音設定。這項偏好只留在目前頁面的記憶體。更新擴充功能及網站後，重新整理網頁，才會載入配合的新程式。

## 取得一般使用者可安裝的版本

### Chrome

1. 用發佈者的 Chrome Web Store 開發者帳戶上傳 `chrome.zip`。
2. 填寫下方的介紹、單一用途、權限及資料聲明，提供真實操作截圖，以及可公開讀取的私隱政策網址。
3. 在商店的私人審查欄位提供網站所需的測試登入／密碼及操作步驟。不要將密碼放入擴充功能、公開說明、截圖或程式庫。
4. 通過審核並發佈後，分享商店安裝連結。一般 Windows／macOS 使用者透過商店取得已簽署版本；自行封裝的 CRX 不是這個一般安裝流程。[Chrome 官方分發說明](https://developer.chrome.com/docs/extensions/how-to/distribute)

### Edge

1. 用發佈者的 Partner Center 帳戶上傳 `edge.zip`，填妥介紹、權限理由、私隱資料及所需素材。
2. 如只想向指定對象提供安裝連結，可選商店的 Hidden 可見度。商店私人測試備註另填網站所需憑證。
3. 通過認證並發佈後，分享 Microsoft Edge Add-ons 連結，供使用者正常安裝及更新。[Edge 官方發佈說明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)

### Firefox

Mozilla 簽署是由 AMO 為通過檢查的套件加入簽章，不是自行替 ZIP 改副檔名。你可用網頁完成整個流程，無須建立或交出 API key。

1. 用 Mozilla 帳戶登入 [Add-ons Developer Hub](https://addons.mozilla.org/developers/)，按 **Submit a New Add-on**（首次提交會顯示首次提交按鈕）。
2. 要自行分享 XPI，選 **On your own**，即 unlisted，不會公開列在 AMO；要公開商店頁則選在 AMO 上架。
3. 上傳 `firefox-unsigned.xpi` 或 `firefox.zip`。處理驗證錯誤，選桌面相容平台，再繼續。按當時要求回答原始碼問題；此包內 JavaScript 未壓縮、未混淆，如審查要求仍須補交指定材料。
4. 網站如需要密碼，在私人審查備註另行提供。完成提交後等待簽署；AMO 會以電郵通知，亦可能要求進一步審查。
5. 在郵件連結或開發者後台打開該附加元件的版本列表，選剛才提交的版本，下載版本頁檔案連結所提供的**已簽署 XPI**。分發這個下載檔，而非原本的 `firefox-unsigned.xpi`。[Mozilla 提交及自行分發流程](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
6. 使用者在 Firefox 開啟 `about:addons`，按齒輪選「從檔案安裝附加元件」，選擇已簽署 XPI。安裝後確認主機存取權，再重新整理 Umininn TV。[Mozilla 檔案安裝說明](https://extensionworkshop.com/documentation/publish/install-self-distributed/)

正常版 Firefox 的一般安裝需要 Mozilla 簽署。[Mozilla 簽署與分發說明](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) 此版本沒有自行託管的更新網址；unlisted 分發的後續版本須重新提交簽署，再讓使用者安裝已簽署的新版本。往後如需自動更新，要另外設置 Mozilla 支援的更新 manifest 及託管流程。

未簽署的 Firefox 套件只可按開發流程暫時載入；重啟瀏覽器後不會保留。Chrome／Edge 的開發人員模式載入亦只屬手動開發安裝。

## 可貼入商店的資料

### 名稱

Umininn TV 播放器控制

### 簡短介紹

在 Umininn TV 集中調整播放器音量、靜音，並檢查及嘗試恢復播放。

### 完整介紹

Umininn TV 播放器控制為 Umininn TV 加入集中播放控制，方便同時觀看多台時管理聲音及檢查播放狀態。

安裝後重新整理 Umininn TV，選台並按「開始觀看」。網站頂部會顯示「🎚 播放控制」及「↻ 偵測恢復」。你可以全部或逐台靜音、開聲、調整音量，也可以逐台嘗試恢復暫停的播放器。「開始觀看」會在各台就緒後檢查一次；「偵測恢復」可由你隨時再執行一輪。畫面會列出等待、未連線或不支援的來源。

擴充功能只控制已授權網域內可辨識的播放器。Twitch、Kick、OK.ru、YouTube、AngelThump 及 GoodGame 的實際可用程度會受播放器結構及平台行為影響。任意 BS 網址及其他未授權來源不在控制範圍。瀏覽器自動播放限制、平台錯誤或失效串流可能仍需你在原播放器按播放。

擴充功能沒有遙測、廣告或外部資料接收服務，也不持久保存控制偏好。網站與播放器網址只在本機用於來源核對及顯示台名；音量、靜音及播放狀態在同一瀏覽器內處理。網站及影片平台本身的資料處理另依各自政策。

### 單一用途

在 Umininn TV 內集中控制已授權播放器的音量、靜音及恢復播放，並顯示這些控制所需的即時狀態。

### 主機權限理由

| 權限範圍 | 可貼入審查欄位的理由 |
| --- | --- |
| `https://umininn-gh.github.io/*` | 在 Umininn TV 的指定首頁及管理頁加入播放控制介面，核對發出控制指令的網站分頁，避免將指令轉送到其他分頁。實際網站腳本只匹配 `/tv/`、`/tv/index.html`、`/tv/admin.html` 及其查詢字串；主機權限的路徑不會限制瀏覽器授權範圍。 |
| `https://player.twitch.tv/*`、`https://player.kick.com/*`、`https://ok.ru/*` | 在獲准的嵌入播放器讀取即時媒體狀態，接收同一個 Umininn TV 分頁的音量、靜音及恢復請求。Twitch 亦可在可辨識時點擊明確的 Play 按鈕，然後確認實際播放。 |
| `https://www.youtube.com/*`、`https://youtube.com/*`、`https://www.youtube-nocookie.com/*`、`https://youtube-nocookie.com/*` | 在這些已知 YouTube 播放器來源讀取媒體狀態及套用使用者的音量、靜音、恢復請求；只接受已核准 Umininn TV 分頁的控制路由。 |
| `https://player.angelthump.com/*`、`https://goodgame.ru/*`、`https://player.goodgame.ru/*` | 在這些已知播放器來源讀取媒體狀態及套用同一 Umininn TV 分頁的音量、靜音、恢復請求。 |

沒有要求 `tabs`、`storage`、`cookies`、`debugger`、`webRequest`、`scripting` 或 `<all_urls>` 權限。程式使用 `tabs.get` 及 `tabs.sendMessage` 核對並轉送目前分頁的指令；網站 URL 存取由已宣告的主機權限提供。正式包不要求 `localhost`／`127.0.0.1` 主機權限，也不在本機網址注入腳本。

### 遠端程式碼

沒有遠端程式碼。所有 JavaScript 及資源隨包提供，不下載或執行遠端腳本，沒有 `eval`。

### 資料使用及私隱聲明

擴充功能不向開發者或第三方傳送、出售或共享使用者資料，沒有分析／遙測服務，也不持久保存資料。它在本機短暫讀取網站／播放器 URL 作來源與分頁核對，從 iframe URL 取得台名，並處理音量、靜音、播放及就緒狀態、分頁／框架識別碼與每份播放器文件的隨機控制令牌。它亦在同一頁內同步「全體靜音／開聲」的布林偏好，讓新增播放器沿用目前設定；偏好只留在記憶體。資料只用於上述播放控制。

這段聲明只描述擴充功能。使用者前往網站、登入網站或播放影片時，網站、瀏覽器及影片平台原有的連線及資料處理仍按各自政策運作。送審表格應按當時欄位對「收集」的定義填寫，並保留上述本機處理說明，不應填成「完全不讀取任何網址或資料」。Firefox manifest 的資料收集聲明為 `required: ["none"]`。

私隱政策原稿：`browser-extension/PRIVACY.zh-HK.html`；套件內檔案為根目錄的 `PRIVACY.zh-HK.html`，亦可從擴充功能彈出頁開啟。**公開政策網址尚未部署，送審前須由發佈者放到免登入可讀的 HTTPS 網頁，確認可開啟後才填入商店。** 本機檔案路徑或擴充功能內頁不能當作商店公開政策 URL。

## 給審查員的私人備註範本

下文可貼入各商店的私人審查／測試備註。網站如要求密碼，由發佈者在私人欄位另行提供；下文及套件均不包含憑證。

```text
This extension adds player controls only to https://umininn-gh.github.io/tv/ and its approved index/admin pages.

If the website asks for a password, use the test credentials supplied separately in this store's private review fields. The extension itself has no login and contains no credentials.

1. Install the extension and grant its declared site/player host permissions. Reload the website after installation.
2. Open the website, complete its access prompt if shown, select available channels, then click 「開始觀看」 (Start watching).
3. Confirm 「🎚 播放控制」 (Player controls) and 「↻ 偵測恢復」 (Check/recover) appear in the header.
4. Open Player controls. Test per-player volume, mute/unmute, and all-player mute/unmute. Volume and mute controls should not reload the iframe.
5. Pause a supported player using its native UI, then use its 「恢復播放」 (Recover) action. Click Check/recover to perform one pass across current players. Already playing players are skipped; unavailable sources are reported.
6. Add or remove a player, then check that the current player list updates. In Firefox, verify the requested host permissions in Add-ons Manager if a frame does not respond.

The extension uses only bundled code. Approved site/frame URLs are checked transiently within the browser; channel labels come from iframe URLs. Local messages carry control commands and media state. There is no telemetry, external data endpoint, persistent extension storage, or credential handling. Website and video-platform traffic belongs to those services.

Live channel availability, platform autoplay rules, and unsupported frame structures can limit playback; a successful request is reported only after playback is observed. The extension does not provide streams or bypass platform access restrictions.
```

## 送審前尚待完成

- 發佈者帳戶、開發者名稱及聯絡方式由帳戶持有人填寫；確認商店私隱聲明與政策一致。
- 部署免登入可讀的 HTTPS 私隱政策；提供實際操作截圖及各商店要求的宣傳素材。
- 在 Chrome／Edge／Firefox 實際安裝 1.0.0，記錄瀏覽器版本、主機權限提示、各平台控制與重新啟動後的行為。正式商店／已簽署版本仍需再驗證安裝及更新流程。
- 0.1.4 曾獲使用者回報三款瀏覽器可用；這不等於 1.0.0 已安裝實測。模型及自動測試亦不取代正式安裝或真實直播測試。
- 上傳套件、完成審核／簽署，取得商店連結或已簽署 XPI 後，才對外提供正式安裝入口。

本次準備只建立本機發佈材料，未提交帳戶、發佈網站或上架擴充功能。
