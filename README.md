# Total-Return-Calc 台股總報酬比較

計算台股上市、上櫃股票與 ETF 指定期間的**含息總報酬**（含現金股利、股票股利、現金增資、分割、減資），最多 10 檔同時比較並繪圖。
**查詢當下才下載「目標標的」指定區間**的股價與除權息資料（通常 1~3 秒），並自動記錄查詢歷史，可釘選常用組合（例如自己的庫存）。

## 安裝

1. 安裝 [Python 3.9+](https://www.python.org/downloads/)（Windows 安裝時勾選「Add python.exe to PATH」）
2. 下載本專案：GitHub 頁面右上綠色「Code」→「Download ZIP」，解壓縮
3. 需要的套件 `requests` 會在第一次啟動時自動安裝（或手動 `pip install -r requirements.txt`）

完整圖文步驟（含 Mac 終端機操作）請見 [使用說明.txt](使用說明.txt)。

## 啟動

Windows 雙擊 `start_v2.bat`；Mac / 其他：

```bash
python server_v2.py
```

會自動開啟 http://localhost:8893/ 。（必須透過 server 開啟，不能直接點 html 檔。）

## 使用

1. 輸入代碼或名稱加入標的（最多 10 檔）。可一次貼上多檔：`2330 0056,00878` 後按 Enter。
2. 選擇區間（1M~10Y、YTD 或自訂），按「查詢」→ 只下載缺少的部分，通常 1~3 秒內完成。
3. 每次查詢自動記錄在下方「查詢歷史」：
   - **★ 釘選**：把常用組合（例如自己的庫存）固定在最上方；開啟網頁時會自動查詢第一組釘選組合。
   - **命名**：例如「我的庫存」「高股息比較」。
   - **重新查詢**：預設區間（如 1Y）會以今天為終點重算，方便追蹤；自訂區間則用原日期。
   - 紀錄中保存當時的報酬率，可與重新查詢的結果對照。
4. 表格的「區間除權息」滑鼠移上去可看每次配息/分割明細。

## 檔案

| 檔案 | 說明 |
|---|---|
| `server_v2.py` | 本機伺服器 (只需 `requests` 套件)；port 被佔用會自動改用下一個 |
| `scripts/ondemand_v2.py` | 即時下載 + 快取 + 後復權計算；也可命令列測試：`python scripts/ondemand_v2.py 2330 --start 2024-01-01` |
| `index_v2.html` / `js/main_v2.js` / `css/style_v2.css` | 前端 + `js/calc.js`、`js/chart.js` |
| `start_v2.bat` / `start_v2_mac.command` | Windows / Mac 一鍵啟動 |
| `data_v2/cache/{code}.json` | 已下載資料快取，查過的區間不再重抓 |
| `data_v2/history.json` | 查詢歷史 |
| `data_v2/stock_list.json` | 股票/ETF 清單 (每 7 天更新) |

## 資料來源

全部來自 FinMind（每檔每類資料只要 1 次 API 呼叫）：股價 `TaiwanStockPrice`、除權息 `TaiwanStockDividendResult`（上市與上櫃都有）、分割 `TaiwanStockSplitPrice`、減資 `TaiwanStockCapitalReductionReferencePrice`、IR0001 `TaiwanStockTotalReturnIndex`。
FinMind 股價失敗時自動改用 TWSE / TPEX 官方逐月下載（較慢）。`data/manual_events.json` 的人工事件仍會套用（若 API 已有相同分割則不重複）。

**FinMind 免費額度**：未登入約每小時 300 次。單檔首次查詢約 4 次呼叫，之後只補新日期；事件每天最多檢查一次。若常查很多檔，可到 FinMind 註冊取得 token，存成 `data_v2/finmind_token.txt`（或設環境變數 `FINMIND_TOKEN`）提高額度。

## 計算方式

後復權因子法：`factor *= 除權息前收盤 / 除權息參考價`，涵蓋現金股利、股票股利、現金增資（假設必認）、分割、減資。
