"""台股總報酬比較 — 本機伺服器 (查詢時才即時下載資料)。

啟動：
    python server.py            # 預設 http://localhost:8893/
    python server.py --port 9000 --no-browser

API：
    GET    /api/stocks                         股票/ETF 清單 (搜尋用)
    GET    /api/series?code=2330&start=&end=   即時下載 + 計算含息後復權序列
    GET    /api/history                        查詢歷史
    POST   /api/history                        新增 (相同組合會移到最上面並更新)
    PATCH  /api/history?id=...                 修改 (pinned / label)
    DELETE /api/history?id=...                 刪除
    POST   /api/history/delete  {"ids": [...]} 批次刪除
"""
from __future__ import annotations
import argparse
import json
import sys
import threading
import traceback
import uuid
import webbrowser
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
import ondemand as od  # noqa: E402
from common import load_json, save_json  # noqa: E402

HISTORY_PATH = od.USER_DIR / "history.json"
HISTORY_MAX = 300
_hist_lock = threading.Lock()


def _hist_load() -> list[dict]:
    return load_json(HISTORY_PATH, default={"items": []}).get("items", [])


def _hist_save(items: list[dict]) -> None:
    save_json(HISTORY_PATH, {"items": items})


def _hist_key(it: dict) -> str:
    rng = it.get("range")
    span = f"{it.get('start')}~{it.get('end')}" if rng == "CUSTOM" else rng
    return "|".join([",".join(it.get("codes", [])), ",".join(sorted(it.get("benchmarks", []))), str(span)])


def hist_add(entry: dict) -> list[dict]:
    with _hist_lock:
        items = _hist_load()
        key = _hist_key(entry)
        old = next((x for x in items if _hist_key(x) == key), None)
        items = [x for x in items if _hist_key(x) != key]
        entry["id"] = old["id"] if old else uuid.uuid4().hex[:12]
        entry["pinned"] = bool(old and old.get("pinned"))
        entry["label"] = (old or {}).get("label", "")
        entry["count"] = (old or {}).get("count", 0) + 1
        items.insert(0, entry)
        # 超過上限時優先刪除最舊的未釘選紀錄
        while len(items) > HISTORY_MAX:
            idx = max((i for i, x in enumerate(items) if not x.get("pinned")), default=None)
            if idx is None:
                break
            items.pop(idx)
        _hist_save(items)
        return items


def hist_patch(hid: str, patch: dict) -> list[dict]:
    with _hist_lock:
        items = _hist_load()
        for x in items:
            if x["id"] == hid:
                if "pinned" in patch:
                    x["pinned"] = bool(patch["pinned"])
                if "label" in patch:
                    x["label"] = str(patch["label"])[:60]
        _hist_save(items)
        return items


def hist_delete(ids: set[str]) -> list[dict]:
    with _hist_lock:
        items = [x for x in _hist_load() if x["id"] not in ids]
        _hist_save(items)
        return items


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ------------------------------------------------------------ helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def _route(self):
        u = urlparse(self.path)
        return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def _handle(self, fn):
        try:
            fn()
        except od.FetchError as e:
            self._json({"error": str(e)}, 502)
        except Exception as e:
            traceback.print_exc()
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    # ------------------------------------------------------------ verbs
    def do_GET(self):
        path, q = self._route()
        if path in ("/", "/index.html"):
            self.path = "/index.html"
            return super().do_GET()
        if path == "/api/stocks":
            return self._handle(lambda: self._json({"stocks": od.stock_list()}))
        if path == "/api/series":
            def run():
                today = date.today()
                start = date.fromisoformat(q.get("start") or f"{today.year - 1}-{today.month:02d}-01")
                end = date.fromisoformat(q.get("end") or today.isoformat())
                self._json(od.query(q.get("code", ""), start, end))
            return self._handle(run)
        if path == "/api/history":
            return self._handle(lambda: self._json({"items": _hist_load()}))
        return super().do_GET()

    def do_POST(self):
        path, _ = self._route()
        if path == "/api/history":
            return self._handle(lambda: self._json({"items": hist_add(self._body())}))
        if path == "/api/history/delete":
            return self._handle(lambda: self._json({"items": hist_delete(set(self._body().get("ids", [])))}))
        self._json({"error": "not found"}, 404)

    def do_PATCH(self):
        path, q = self._route()
        if path == "/api/history":
            return self._handle(lambda: self._json({"items": hist_patch(q.get("id", ""), self._body())}))
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        path, q = self._route()
        if path == "/api/history":
            return self._handle(lambda: self._json({"items": hist_delete({q.get("id", "")})}))
        self._json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8893)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    od.USER_DIR.mkdir(exist_ok=True)
    # Windows 的 SO_REUSEADDR 會讓兩個程式綁同一個 port，必須關閉才偵測得到衝突
    ThreadingHTTPServer.allow_reuse_address = sys.platform != "win32"
    srv = None
    for port in range(a.port, a.port + 20):  # port 被佔用就往後找
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit(f"找不到可用的 port ({a.port}~{a.port + 19})")
    url = f"http://localhost:{port}/"
    print(f"台股總報酬比較 → {url}  (Ctrl+C 結束)")
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
