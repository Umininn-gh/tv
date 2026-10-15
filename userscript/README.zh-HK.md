# Umininn TV 播放器控制 Userscript

版本：1.0.1。Chrome、Edge、Firefox 使用同一份 `umininn-tv-player.user.js`，透過腳本管理器安裝。腳本更新不需要向 Mozilla 送簽；安裝內容由腳本管理器保存，重啟瀏覽器後仍會保留。

## 1.0.1 載入等待修正

修正已連線的 Twitch iframe 建立空 `<video>`（`readyState=0`）後被過早視為就緒的問題。自動偵測現在要等影片 metadata 載入，或明確可用的 Twitch Play 按鈕出現，再穩定 600ms 才加入恢復佇列；尚未就緒的台不再提前消耗一次恢復，其他已就緒的台仍先處理。整輪仍以 30 秒為限，沒有背景持續重試。

送出恢復指令前會再用最新狀態核對一次；排隊期間失去就緒狀態，或 30 秒到期仍未就緒的台，會列為未就緒，不會強行送出恢復。

這項修正不代表所有 Firefox 暫停問題都已確認原因。如果 Firefox 拒絕腳本啟動播放，仍需在原播放器按播放，或在 Firefox 為該網站調整自動播放權限。[Mozilla 自動播放說明](https://support.mozilla.org/zh-TW/kb/block-autoplay)

## 安裝

1. 在各個要使用的瀏覽器安裝 [Tampermonkey](https://www.tampermonkey.net/)。已使用 Violentmonkey 的 Firefox 亦可使用同一份腳本。
2. 停用舊的「Umininn TV 播放器控制」擴充功能，以及其他相同用途的舊腳本。
3. 在首頁「台務 → userscript」開啟腳本視窗，按「複製」。在 Tampermonkey 控制台按「新增腳本」，刪除預設範本，貼入**全部內容**並按 Ctrl+S 儲存。亦可直接使用 `umininn-tv-player.user.js` 檔案的內容。確認腳本已啟用。[官方安裝方法](https://www.tampermonkey.net/faq.php?q=Q102)
4. Chrome／Edge 如顯示需要執行權限，在 Tampermonkey 的擴充功能詳細資料開啟「允許使用者指令碼／Allow User Scripts」；較舊版本按管理器提示開啟開發人員模式。[官方權限說明](https://www.tampermonkey.net/faq.php?q=Q209)
5. 確認腳本管理器可在本站及腳本列出的播放器網域執行，重新整理 Umininn TV，登入並開始觀看。

Violentmonkey 可從工具列「＋」開啟新腳本編輯器，貼入完整內容後儲存。[官方說明](https://violentmonkey.github.io/guide/creating-a-userscript/)

本機安裝不需要先發佈網站。日後若將 `.user.js` 部署到 HTTPS 網址，開啟該網址也可觸發腳本管理器的安裝畫面；目前交付的是本機檔案，沒有聲稱線上安裝網址已部署。

## 使用

- 網站頂部「🎚 播放控制」開啟控制選單，可全部／逐台靜音、開聲及調整音量。
- 「↻ 偵測恢復」重新讀取各台狀態，已播放／緩衝中的台會略過，對可控制而未播放的台各嘗試恢復一次。逐台的「恢復播放」亦保留。
- 在「看更台」按「開始觀看」，各台就緒穩定後加入本輪恢復，不必等齊慢台；載入等待最多 30 秒，同時最多 4 項恢復操作。
- 改音量及靜音不重載 iframe，不會為此恢復人手暫停的台。來源不支援、尚未連線或瀏覽器拒絕自動播放時，會顯示狀態；必要時在原播放器按 Play。
- 登入後才建立的網站介面、新增／移除播放器，以及 CSS 搬位均沿用現有處理。選單標題顯示腳本版本。

支援範圍沿用原擴充功能：本站原生 HTML 媒體，以及 `player.twitch.tv`、`player.kick.com`、`ok.ru`、YouTube／YouTube No-Cookie、AngelThump、GoodGame 指定播放器主機內可辨識的 HTML 媒體。實際可用程度仍取決於播放器結構、來源及平台政策；未知 BS 網域或巢狀跨來源播放器不會自動獲得控制權限。

## 更新

在腳本管理器打開**已安裝的同一個腳本**，用新版 `.user.js` 的完整內容取代並儲存，再重新整理網站。保留檔案內的 `@name` 和 `@namespace`，不要另外建立重複的腳本。開發者發行更新時提高 `@version`。

目前未配置線上自動更新來源，不會默認從尚未部署的網址取回腳本。`.meta.js` 只是版本標頭，安裝時應使用完整 `.user.js`。

## 網站的聲音偏好同步

本程式庫的 `tv-app.js` 與 `admin.html` 已加入同頁聲音偏好接收，讓「全部靜音／開聲」後增減選台仍沿用該選擇，並保留仍在播放的 iframe。這項網站修正須隨網站部署才會在正式網址生效；腳本本身的音量、靜音及恢復控制可獨立運作。

## 權限與資料

腳本只匹配本站指定觀看頁及固定 HTTPS 播放器主機，不匹配 `localhost`、管理頻道資料頁或任意網站；即使手動貼入其他頁面，啟動時亦會重新核對網址。外站播放器只有收到已核准父頁的探測後才建立控制器。

沒有要求 `GM_*` 資料儲存、跨來源請求或 `unsafeWindow` 權限，沒有遠端 `@require`、遙測、憑證處理或持久控制偏好。模組封裝在私有作用域，跨頁框指令只在本機瀏覽器傳遞；每次文件會有獨立隨機識別，舊文件、錯誤來源及重複指令會被拒絕。腳本管理器和直播平台本身的資料處理由各自政策負責。

Tampermonkey 使用 `@sandbox DOM`，Violentmonkey 使用 `@inject-into content`；只需 DOM 操作。這些設定及未要求特權 API 的標頭，不會要求腳本取得頁面內的 JavaScript 變數。相關文件：[Tampermonkey sandbox](https://www.tampermonkey.net/documentation.php?q=sandbox)、[Violentmonkey metadata](https://violentmonkey.github.io/api/metadata-block/)。

## 建置與驗證

```powershell
node tools/build-player-userscript.cjs
node --test "tests/player-userscript-*.test.cjs" "tests/player-extension-*.test.cjs"
```

建置把 `browser-extension/shared/` 的媒體、Twitch 及恢復流程和控制介面，與 `userscript/transport.js`、`bootstrap.js` 合成單一檔案。不要手動修改產出的 `.user.js`；修改來源後重新建置。輸出是本資料夾的發行檔，以及 `outputs/player-userscript/` 的相同副本與 `.meta.js`。

瀏覽器整合測試可選用 `UMININN_BROWSER_TESTS=1` 執行，需可用的 Playwright 與相應瀏覽器引擎。預設 Chromium／Edge；設定 `UMININN_BROWSER_ENGINE=firefox` 可測 Firefox。測試把實際腳本注入網站／跨來源播放器模型，驗證真實 `postMessage` 及 HTML 媒體控制；這不等於已在 Tampermonkey／Violentmonkey 或三款瀏覽器實際安裝，也不代表所有外站直播已驗證。

2026-10-16，1.0.0 驗證：Userscript 的封裝及通訊測試 28 項通過，1 項符號連結測試因 Windows 權限略過；無頭 Edge 瀏覽器模型測試 4／4 通過，包括實際 HTML 媒體音量、靜音、恢復播放、跨來源訊息、移除／重新建立播放器、錯誤來源拒絕、重複安裝防護及登入後掛載。

2026-10-16，1.0.1 驗證：共享播放器、就緒排程、封裝及通訊等回歸測試 170 項通過，7 項因選用瀏覽器測試／Windows 符號連結權限略過。Firefox 153 引擎的 6／6 模型測試通過；Chromium 155 的 5／5 共用模型測試通過，另略過 Firefox 專屬自動播放政策測試。空影片會等待遲來的 Play，播放後不再重複點擊；Firefox 嚴格封鎖自動播放時會如實回報拒絕或尚未確認，不會當作恢復成功，親自在 iframe 按 Play 則能播放。這些仍屬本地模型，未驗證 Firefox Tampermonkey 與真實 Twitch 的組合。
