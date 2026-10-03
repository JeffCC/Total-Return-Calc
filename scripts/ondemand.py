"""即時查詢引擎：查詢當下才下載「目標標的」指定區間的股價與除權息資料。

資料來源 (每檔每類只需 1 次 API 呼叫，不再逐月抓):
- 股價 (未還原)        : FinMind TaiwanStockPrice
- 除權息 (前收/參考價)  : FinMind TaiwanStockDividendResult   (上市、上櫃、ETF 都有)
- 股票分割 / 反分割     : FinMind TaiwanStockSplitPrice
- 減資 (彌補虧損/退現)  : FinMind TaiwanStockCapitalReductionReferencePrice
- 加權報酬指數 IR0001   : FinMind TaiwanStockTotalReturnIndex (data_id=TAIEX)
- 股票清單 (代碼/名稱)  : FinMind TaiwanStockInfo (每 7 天更新一次)

若 FinMind 股價失敗 (例如限流)，自動改用 TWSE STOCK_DAY / TPEX tradingStock 逐月抓 (較慢)。

快取 (userdata/cache/{code}.json)：已下載過的區間不再重抓，只補缺口；
事件資料每天最多重新檢查一次。

後復權公式與 v1 相同：factor *= 除權息前收盤 / 除權息參考價。

FinMind 免費額度：未登入約 300 次/小時。若常查詢，可在
userdata/finmind_token.txt 放入 FinMind token (或設環境變數 FINMIND_TOKEN) 提高額度。
"""
from __future__ import annotations
import os
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import session, load_json, save_json, fmt_iso, ROOT, MANUAL_EVENTS_PATH
import fetch_prices

USER_DIR = ROOT / "userdata"
CACHE_DIR = USER_DIR / "cache"
STOCK_LIST_PATH = USER_DIR / "stock_list.json"
TOKEN_PATH = USER_DIR / "finmind_token.txt"

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
EARLIEST = date(2000, 1, 1)
TW = timezone(timedelta(hours=8))
STOCK_LIST_TTL_DAYS = 7

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class FetchError(Exception):
    pass


def _lock_for(code: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(code, threading.Lock())


def tw_now() -> datetime:
    return datetime.now(TW)


def safe_data_end() -> date:
    """今天收盤資料約 14:30 後才會出現；之前只能確定抓到昨天。"""
    now = tw_now()
    return now.date() if now.hour >= 15 else now.date() - timedelta(days=1)


# ---------------------------------------------------------------- FinMind

def _token() -> str:
    tok = os.environ.get("FINMIND_TOKEN", "").strip()
    if not tok and TOKEN_PATH.exists():
        tok = TOKEN_PATH.read_text(encoding="utf-8").strip()
    return tok


def finmind(dataset: str, data_id: str | None = None, start: date | None = None,
            end: date | None = None) -> list[dict]:
    s = session()
    tok = _token()
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    params = {"dataset": dataset}
    if data_id:
        params["data_id"] = data_id
    if start:
        params["start_date"] = fmt_iso(start)
    if end:
        params["end_date"] = fmt_iso(end)
    try:
        r = s.get(FINMIND_URL, params=params, timeout=60)
        js = r.json()
    except Exception as e:
        raise FetchError(f"FinMind {dataset} 連線失敗：{e}")
    if js.get("status") == 402 or r.status_code == 402 or "upper limit" in str(js.get("msg", "")).lower():
        raise FetchError("FinMind 免費查詢額度已滿（每小時約 300 次），請等待約一小時後再查詢。")
    if js.get("status") != 200:
        raise FetchError(f"FinMind {dataset} 錯誤 ({js.get('status')})：{js.get('msg')}")
    return js.get("data", [])


# ---------------------------------------------------------------- 股票清單

def stock_list(force: bool = False) -> list[dict]:
    cached = load_json(STOCK_LIST_PATH)
    if cached and not force:
        age = date.today() - date.fromisoformat(cached["fetched"])
        if age.days < STOCK_LIST_TTL_DAYS:
            return cached["stocks"]
    try:
        rows = finmind("TaiwanStockInfo")
    except FetchError:
        if cached:
            return cached["stocks"]
        raise
    by_code: dict[str, dict] = {}
    for r in rows:
        code = str(r.get("stock_id", "")).strip()
        t = r.get("type", "")
        if not code or t not in ("twse", "tpex"):
            continue
        prev = by_code.get(code)
        if prev is None or (r.get("date") or "") >= prev["_d"]:
            by_code[code] = {
                "code": code,
                "name": r.get("stock_name", ""),
                "market": "TWSE" if t == "twse" else "TPEX",
                "industry": r.get("industry_category", ""),
                "_d": r.get("date") or "",
            }
    stocks = sorted(({k: v for k, v in s.items() if k != "_d"} for s in by_code.values()),
                    key=lambda s: s["code"])
    stocks.append({"code": "IR0001", "name": "加權報酬指數", "market": "INDEX", "industry": "指數"})
    save_json(STOCK_LIST_PATH, {"fetched": fmt_iso(date.today()), "stocks": stocks})
    return stocks


def lookup(code: str) -> dict:
    for s in stock_list():
        if s["code"] == code:
            return s
    return {"code": code, "name": "", "market": "TWSE", "industry": ""}


# ---------------------------------------------------------------- 下載

def _fetch_prices_finmind(code: str, start: date, end: date) -> list[dict]:
    if code == "IR0001":
        rows = finmind("TaiwanStockTotalReturnIndex", "TAIEX", start, end)
        return [{"d": r["date"], "c": float(r["price"])} for r in rows if r.get("price")]
    rows = finmind("TaiwanStockPrice", code, start, end)
    return [{"d": r["date"], "c": float(r["close"])} for r in rows if r.get("close")]


def _fetch_prices_official(code: str, market: str, start: date, end: date) -> list[dict]:
    rows, _name, failed = fetch_prices.fetch_one(code, market, start, end)
    if failed:
        raise FetchError(f"{code} 官方股價抓取在 {failed[0]}-{failed[1]:02d} 失敗")
    return [{"d": r["d"], "c": r["c"]} for r in rows]


def fetch_prices_range(code: str, market: str, start: date, end: date) -> tuple[list[dict], str]:
    try:
        return _fetch_prices_finmind(code, start, end), "FinMind"
    except FetchError as e:
        if code == "IR0001":
            raise
        print(f"  ! {e} → 改用 {market} 官方逐月下載")
        return _fetch_prices_official(code, market, start, end), market


def fetch_events(code: str) -> list[dict]:
    """全部歷史事件 (資料量小，一次抓完)。回傳 [{date, prev_close, ref_price, type_label}]."""
    if code == "IR0001":
        return []
    out = []
    for r in finmind("TaiwanStockDividendResult", code, EARLIEST):
        pc, rp = float(r.get("before_price") or 0), float(r.get("reference_price") or 0)
        if pc > 0 and rp > 0:
            out.append({"date": r["date"], "prev_close": pc, "ref_price": rp,
                        "type_label": r.get("stock_or_cache_dividend", "") or "除權息"})
    for r in finmind("TaiwanStockSplitPrice", code, EARLIEST):
        pc, rp = float(r.get("before_price") or 0), float(r.get("after_price") or 0)
        if pc > 0 and rp > 0:
            out.append({"date": r["date"], "prev_close": pc, "ref_price": rp,
                        "type_label": "split", "note": r.get("type", "")})
    for r in finmind("TaiwanStockCapitalReductionReferencePrice", code, EARLIEST):
        pc = float(r.get("ClosingPriceonTheLastTradingDay") or 0)
        rp = float(r.get("PostReductionReferencePrice") or 0)
        if pc > 0 and rp > 0:
            out.append({"date": r["date"], "prev_close": pc, "ref_price": rp,
                        "type_label": "split", "note": "減資：" + str(r.get("ReasonforCapitalReduction", ""))})
    # 人工補錄事件：同日期覆蓋；分割若 API 已有 (日期差幾天內) 則不重複套用
    manual = load_json(MANUAL_EVENTS_PATH, default={}).get(code, [])
    for m in manual:
        if not isinstance(m, dict):
            continue
        md = date.fromisoformat(m["date"])
        dup = any(e["type_label"] == m.get("type_label") and
                  abs((date.fromisoformat(e["date"]) - md).days) <= 7 for e in out)
        if not dup:
            out.append({k: v for k, v in m.items() if k in ("date", "prev_close", "ref_price", "type_label", "note")})
    out.sort(key=lambda e: e["date"])
    return out


# ---------------------------------------------------------------- 快取 + 組裝

def _merge_rows(a: list[dict], b: list[dict]) -> list[dict]:
    m = {r["d"]: r for r in a}
    for r in b:
        m[r["d"]] = r
    return [m[d] for d in sorted(m)]


def ensure_data(code: str, start: date, end: date) -> tuple[dict, list[str]]:
    """確保快取涵蓋 [start, end]，回傳 (cache_obj, 本次下載動作說明)。"""
    end = min(end, safe_data_end())
    path = CACHE_DIR / f"{code}.json"
    with _lock_for(code):
        info = lookup(code)
        c = load_json(path) or {"code": code, "rows": [], "from": None, "to": None,
                                "events": [], "events_checked": None}
        c["name"] = info.get("name") or c.get("name", "")
        c["market"] = info.get("market") or c.get("market", "TWSE")
        actions: list[str] = []
        changed = False

        gaps = []
        if c["from"] is None:
            gaps.append((start, end))
        else:
            cf, ct = date.fromisoformat(c["from"]), date.fromisoformat(c["to"])
            if start < cf:
                gaps.append((start, cf - timedelta(days=1)))
            if end > ct:
                gaps.append((ct + timedelta(days=1), end))
        for gs, ge in gaps:
            if gs > ge:
                continue
            rows, src = fetch_prices_range(code, c["market"], gs, ge)
            c["rows"] = _merge_rows(c["rows"], rows)
            c["from"] = fmt_iso(min(gs, date.fromisoformat(c["from"]))) if c["from"] else fmt_iso(gs)
            c["to"] = fmt_iso(max(ge, date.fromisoformat(c["to"]))) if c["to"] else fmt_iso(ge)
            actions.append(f"股價 {gs}~{ge} ({src}, {len(rows)} 筆)")
            changed = True

        if code != "IR0001" and c.get("events_checked") != fmt_iso(date.today()):
            c["events"] = fetch_events(code)
            c["events_checked"] = fmt_iso(date.today())
            actions.append(f"除權息/分割/減資事件 ({len(c['events'])} 筆)")
            changed = True

        if changed and c["rows"]:  # 代碼錯誤 (完全無資料) 不寫快取
            c["fetched_at"] = tw_now().isoformat(timespec="seconds")
            save_json(path, c)
        return c, actions


def build_series(c: dict, start: date, end: date) -> dict:
    """在區間內輸出 [{d, c (split-adjusted), a (含息後復權)}]。"""
    s_iso, e_iso = fmt_iso(start), fmt_iso(end)
    rows = [r for r in c["rows"] if s_iso <= r["d"] <= e_iso]
    events = [e for e in c.get("events", []) if e["prev_close"] > 0 and e["ref_price"] > 0]
    n = len(rows)
    ft, fs = [1.0] * n, [1.0] * n
    k = len(events) - 1
    cur_t = cur_s = 1.0
    for i in range(n - 1, -1, -1):
        d = rows[i]["d"]
        while k >= 0 and events[k]["date"] > d:
            ratio = events[k]["ref_price"] / events[k]["prev_close"]
            cur_t *= ratio
            if events[k].get("type_label") == "split":
                cur_s *= ratio
            k -= 1
        ft[i], fs[i] = cur_t, cur_s
    out_rows = [{"d": r["d"], "c": round(r["c"] * fs[i], 6), "a": round(r["c"] * ft[i], 6)}
                for i, r in enumerate(rows)]
    first = rows[0]["d"] if rows else s_iso
    ev_out = [{"date": e["date"], "prev_close": e["prev_close"], "ref_price": e["ref_price"],
               "ratio": round(e["prev_close"] / e["ref_price"], 6), "label": e.get("type_label", ""),
               "note": e.get("note", "")}
              for e in events if first < e["date"] <= e_iso]
    return {"code": c["code"], "name": c.get("name", ""), "market": c.get("market", ""),
            "rows": out_rows, "events": ev_out}


def query(code: str, start: date, end: date) -> dict:
    code = code.strip().upper()
    if not code:
        raise FetchError("未指定代碼")
    start = max(start, EARLIEST)
    if start > end:
        raise FetchError("起始日晚於結束日")
    c, actions = ensure_data(code, start, end)
    out = build_series(c, start, end)
    out["downloaded"] = actions
    out["fetched_at"] = c.get("fetched_at")
    if not out["rows"]:
        raise FetchError(f"{code} 在 {start}~{end} 沒有股價資料 (代碼錯誤或尚未上市？)")
    return out


if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser()
    ap.add_argument("code")
    ap.add_argument("--start", default=fmt_iso(date.today() - timedelta(days=365)))
    ap.add_argument("--end", default=fmt_iso(date.today()))
    a = ap.parse_args()
    res = query(a.code, date.fromisoformat(a.start), date.fromisoformat(a.end))
    rows = res["rows"]
    print(json.dumps({k: v for k, v in res.items() if k != "rows"}, ensure_ascii=False, indent=1))
    print(f"{len(rows)} rows; TR = {rows[-1]['a'] / rows[0]['a'] - 1:.4%}, price = {rows[-1]['c'] / rows[0]['c'] - 1:.4%}")
