# Open Fitness

語言：[English](README.md) | 繁體中文 | [简体中文](README_zh-CN.md)

Open Fitness 是一套私密、自架的健身紀錄工具，把訓練、飲食、身體測量、恢復和
訓練計劃放在同一處。你可以繼續使用原有的健身 App 和裝置，不必再從聊天、
筆記和不同匯出檔案中拼湊自己的進度。

平日可以直接用適合手機操作的網頁介面記錄；如果想用相片或幾句自然語言完成
記錄，也可連接 AI 助手。固定而重複的資料則可選擇透過 iPhone 捷徑或 API
自動傳入。AI 和自動化功能都是選用，網頁介面本身即可獨立運作。

| 今日 | 飲食 |
| --- | --- |
| ![以合成訓練計劃展示的 Open Fitness 手機版今日頁面](docs/assets/open-fitness-today-mobile.png) | ![以合成待辦餐單展示的 Open Fitness 手機版飲食頁面](docs/assets/open-fitness-nutrition-mobile.png) |

## 訓練、飲食與進度

### 訓練

- 自訂訓練與恢復日的次序，不限於 Leg／Push／Pull。
- 建立固定課表和替代動作，並標示一般課、減量課或測試課。
- 同一課訓練可以一次完成，也可以分時段、分場地記錄。
- 查看相關的上一課作比較。訓練計劃只會在你確認後才套用進度調整。

### 飲食

- 儲存常用食物和餐點組合。
- 分開顯示待辦餐單與真正吃過的餐點。
- 追蹤熱量和蛋白質目標。
- 選擇從 iPhone 捷徑等來源匯入暫計或已結算的 Active Energy。

### 進度

- 查看體重、身體組成、力量、心肺和恢復的長期變化。
- 修正紀錄時保留原有資料，不會無聲覆寫。
- 在記錄頁查看完整時間軸，不必依賴聊天記憶。

## 記錄方式

三種輸入方式最後都會更新同一個 SQLite 資料庫：

1. **網頁介面：** 適合快速手動記錄和日常查看。
2. **AI 助手（選用）：** 適合相片、自然語言回報、修正、問題和根據紀錄提出的
   建議。
3. **自動化（選用）：** 透過 iPhone 捷徑或 API 傳入特定、固定而重複的資料。

AI 助手透過隨附外掛寫入時，Open Fitness 會先檢查內容，只進行一次變更，再讀回
實際結果才確認成功。沒有提供的資料會留空，不會自行猜測。

[Open Fitness 的運作方式](docs/WORKFLOWS.md)（英文）有更詳細的資料來源、
寫入流程和私隱邊界圖。

## 安裝 Open Fitness

Open Fitness 目前供單一使用者使用。你需要 Git、Node.js 22.18 或更新版本，以及
一部由你管理、可安全保存應用程式和 SQLite 資料庫的電腦。

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/EddieTYP/open-fitness.git
cd open-fitness
npm ci
```

然後依照[通用自架指南](docs/operations/SELF-HOSTING.md)：

1. 在儲存庫以外建立空白資料庫；
2. 產生登入密碼雜湊和互不共用的秘密值；
3. 將 `.env.example` 複製成只有你可讀取的 `.env.local`；
4. 建置程式，並讓它只在本機開放；以及
5. 如需遠端使用，才透過私人 HTTPS 或你管理的 VPN 開放。

登入後設定語言、時區、目標、訓練循環和營養目標，就可以直接使用網頁介面。

[新使用者入門指南](docs/ONBOARDING.md)（英文）包含由空白資料庫到選用自動化和
AI 設定的完整步驟。

## 連接 AI 助手（選用）

`agent-plugin/` 目錄提供可攜式
[Agent Plugins v1](https://agent-plugins.org/specification) 套件。相容的用戶端
會載入 Open Fitness skill 和兩個工具：

- `fitness_read` 只取得當前工作需要的資料；
- `fitness_write` 檢查變更內容，並核對實際保存結果。

Open Fitness 不指定模型供應商、聊天 App、記憶系統或 AI 用戶端。外掛不含任何
憑證；用戶端須透過私人環境或秘密儲存區提供 `FITNESS_API_BASE_URL` 和
`FITNESS_API_TOKEN`。

AI 助手適合處理不方便逐項輸入的內容，但正式紀錄仍保存在 Open Fitness。傳送
健康資料或相片前，請先查看所選 AI 供應商的資料保留、模型訓練和私隱條款。

設定方法見[選用 AI 設定](docs/ONBOARDING.md#3-connect-any-compatible-agent-optional)
（英文）。[Hermes](integrations/hermes/README.md) 是其中一個相容用戶端，並非
使用 Open Fitness 的必要條件。

## 資料與私隱

- SQLite 資料庫是正式紀錄。
- 網頁登入、AI 存取和自動化／API 存取分別使用不同憑證。
- 健康紀錄、憑證、資料庫、匯出檔和私人證書不應提交到 Git。
- 程式預設只在本機開放；如需遠端使用，請自行設定私人 HTTPS 或 VPN。
- 經 AI 用戶端傳送的資料，亦受所選供應商的私隱條款約束。

連接 AI 前請先閱讀[新使用者入門指南](docs/ONBOARDING.md)；遷移或還原資料庫前，
請閱讀[備份與還原](docs/operations/BACKUP-RESTORE.md)（英文）。

## 語言與目前範圍

產品和網頁介面支援 `en`、`zh-HK`、`zh-TW` 和 `zh-CN`。語言設定會套用
到系統產生的訓練計劃、課程回顧、進度說明和記錄標籤。使用者指定的文字、品牌
或產品名稱，以及透過 API 傳入的欄位會保留原文。AI 為保存內容撰寫文字時，會使用
個人檔案設定的語言；介面不會重新翻譯舊紀錄。詳情見
[國際化說明](docs/I18N.md)（英文）。

0.1.0 版是單一使用者的自架版本，不包含託管雲端服務、多使用者帳戶或原生 iOS
App。Open Fitness 不是醫療器材，亦不能取代專業醫療意見。

## 文件

| 指南 | 內容 |
| --- | --- |
| [新使用者入門指南](docs/ONBOARDING.md) | 首次設定和選用連接 |
| [通用自架指南](docs/operations/SELF-HOSTING.md) | 安裝、啟動和安全升級 |
| [備份與還原](docs/operations/BACKUP-RESTORE.md) | 保護和還原 SQLite 資料庫 |
| [Open Fitness 的運作方式](docs/WORKFLOWS.md) | 資料來源、寫入流程和私隱邊界 |
| [產品願景](docs/PRODUCT-VISION.md) | 設計原則、發展方向和不包括的範圍 |
| [安全政策](SECURITY.md) | 私下回報安全漏洞 |

## 開發

```bash
npm ci
npm run check
npm run lint
npm test
npm run build
```

切勿讓開發或測試環境連接正在使用的 SQLite 資料庫。資料庫和版本操作載於
`docs/operations/`；缺少必要路徑或安全檢查時，工具會停止執行。

## 授權

Open Fitness 核心程式碼採用 [AGPL-3.0-or-later](LICENSE) 授權。授權範圍和
第三方項目見 [NOTICE](NOTICE)。如機構需要其他條款，可向版權持有人查詢商業
授權。

外部程式碼貢獻暫時不開放，直至正式公布貢獻授權條款；詳情見
[CONTRIBUTING.md](CONTRIBUTING.md)。
