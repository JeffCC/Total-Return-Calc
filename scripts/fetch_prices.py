"""抓取個股日成交資訊（上市/上櫃），輸出 data/raw/prices/{code}.json。

API:
- TWSE: https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=YYYYMMDD&stockNo=CODE&response=json
- TPEX: https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?date=YYYY/MM/DD&code=CODE&response=json
       (新版 TPEX, 2024 改版後)

每月一次查詢，回傳該月份所有交易日。增量更新時只抓最新月份起。
"""
from __future__ import annotations
import sys
from datetime import date, timedelta
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import session, polite_sleep, load_json, save_json, RAW_DIR, START_DATE, fmt_iso

PRICES_DIR = RAW_DIR / "prices"
TWSE_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY"
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock"


def _to_float(s: str) -> float | None:
    s = (s or "").replace(",", "").strip()
    if s in ("", "--", "-", "X"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fetch_twse_month(s, code: str, year: int, month: int):
    """TWSE STOCK_DAY: 回傳 (rows, name)。rows = [{d,o,h,l,c,v}]。"""
    yyyymmdd = f"{year:04d}{month:02d}01"
    params = {"date": yyyymmdd, "stockNo": code, "response": "json"}
    r = s.get(TWSE_URL, params=params, timeout=60)
    r.raise_for_status()
    js = r.json()
    if js.get("stat") != "OK":
        return [], ""
    # title 例: "114年04月 2330 台灣積體電路製造股份有限公司 各日成交資訊"
    title = js.get("title", "")
    import re as _re
    name = ""
    m = _re.search(r"\d{4,5}[A-Z]?\s+(\S+)", title)
    if m:
        name = m.group(1).split("各日")[0].strip()
    rows = []
    for row in js.get("data", []):
        # row: [日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 成交筆數]
        d_roc = row[0]
        try:
            y, m, d = d_roc.split("/")
            d_iso = f"{int(y)+1911:04d}-{int(m):02d}-{int(d):02d}"
        except Exception:
            continue
        c = _to_float(row[6])
        if c is None:
            continue
        rows.append({
            "d": d_iso,
            "o": _to_float(row[3]),
            "h": _to_float(row[4]),
            "l": _to_float(row[5]),
            "c": c,
            "v": int((row[1] or "0").replace(",", "") or 0),
        })
    return rows, name


def fetch_tpex_month(s, code: str, year: int, month: int):
    """TPEX tradingStock: 西元年/月格式。回傳 (rows, name)。"""
    date_str = f"{year:04d}/{month:02d}/01"
    params = {"date": date_str, "code": code, "response": "json"}
    r = s.get(TPEX_URL, params=params, timeout=60)
    r.raise_for_status()
    js = r.json()
    name = ""
    if isinstance(js, dict):
        title = js.get("title") or (js.get("tables", [{}])[0].get("title", "") if "tables" in js else "")
        import re as _re
        m = _re.search(r"\d{4,5}[A-Z]?\s+(\S+)", title or "")
        if m:
            name = m.group(1).split("各日")[0].strip()
    rows_in = js.get("tables", [{}])[0].get("data") if "tables" in js else js.get("data", [])
    if not rows_in:
        return [], name
    out = []
    for row in rows_in:
        # 新版 TPEX 欄位: [日期(民國), 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 成交筆數]
        d_roc = row[0]
        try:
            parts = d_roc.replace("/", "-").split("-")
            if len(parts) == 3:
                y, m, d = parts
                d_iso = f"{int(y)+1911:04d}-{int(m):02d}-{int(d):02d}"
            else:
                continue
        except Exception:
            continue
        c = _to_float(row[6])
        if c is None:
            continue
        out.append({
            "d": d_iso,
            "o": _to_float(row[3]),
            "h": _to_float(row[4]),
            "l": _to_float(row[5]),
            "c": c,
            "v": int((row[1] or "0").replace(",", "") or 0),
        })
    return out, name


def month_iter(start: date, end: date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            y += 1
            m = 1


def fetch_one(code: str, market: str, start: date, end: date):
    """Return (rows, name, failed_month). 內建 retry: 失敗時等 3s 再試一次。

    若某月 3 次 retry 全失敗 → 停止繼續 (不再抓後面的月),回傳到目前為止的 rows
    並在 failed_month 標記卡住的 (year, month)。這樣下次增量會從缺口重試,不會有 gap。
    """
    s = session()
    fetcher = fetch_twse_month if market == "TWSE" else fetch_tpex_month
    all_rows = []
    seen = set()
    name_seen = ""
    failed_month = None
    for y, m in month_iter(start, end):
        rows, nm = None, ""
        for attempt in range(3):
            try:
                rows, nm = fetcher(s, code, y, m)
                break
            except Exception as e:
                print(f"  ! {code} {y}-{m:02d} attempt {attempt+1}: {e}")
                polite_sleep(3.0 + attempt * 2)
        if rows is None:
            failed_month = (y, m)
            print(f"  !!! {code} {y}-{m:02d} FAILED after 3 retries — stopping here, next run will resume")
            break
        if nm and not name_seen:
            name_seen = nm
        for r in rows:
            if r["d"] in seen:
                continue
            if r["d"] < fmt_iso(start) or r["d"] > fmt_iso(end):
                continue
            seen.add(r["d"])
            all_rows.append(r)
        polite_sleep()
    all_rows.sort(key=lambda r: r["d"])
    return all_rows, name_seen, failed_month


def update_ticker(code: str, market: str, end: date | None = None):
    """Return (existing_dict, failed_month)。failed_month 若非 None 代表這次卡在該月,
    下次跑會從那裡繼續補。"""
    """增量更新：讀現有 JSON，從最後日 +1 開始抓到 end（預設今天）。"""
    end = end or date.today()
    path = PRICES_DIR / f"{code}.json"
    existing = load_json(path, default={"code": code, "market": market, "rows": []})
    rows = existing.get("rows", [])
    if rows:
        last_d = date.fromisoformat(rows[-1]["d"])
        start = last_d + timedelta(days=1)
        if start > end:
            print(f"  [{code}] up-to-date ({last_d})")
            return existing, None
    else:
        start = START_DATE
    print(f"  [{code}] fetching {market} {start} → {end}")
    new_rows, name, failed_month = fetch_one(code, market, start, end)
    if name and not existing.get("name"):
        existing["name"] = name
    if new_rows:
        rows.extend(new_rows)
        rows.sort(key=lambda r: r["d"])
        existing["rows"] = rows
        existing["market"] = market
        existing["last_updated"] = fmt_iso(date.today())
        save_json(path, existing)
        print(f"  [{code}] {existing.get('name','')} +{len(new_rows)} rows, total {len(rows)}")
    else:
        save_json(path, existing)
        print(f"  [{code}] no new rows")
    return existing, failed_month


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("code")
    ap.add_argument("--market", choices=["TWSE", "TPEX"], default="TWSE")
    args = ap.parse_args()
    update_ticker(args.code, args.market)
