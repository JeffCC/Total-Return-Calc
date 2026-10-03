"""共用工具：日期、檔案路徑、HTTP session。"""
from __future__ import annotations
import json
import time
from datetime import date, datetime
from pathlib import Path
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TICKERS_DIR = DATA / "tickers"
BENCH_DIR = DATA / "benchmarks"
RAW_DIR = DATA / "raw"
UNIVERSE_PATH = DATA / "universe.json"
MANUAL_EVENTS_PATH = DATA / "manual_events.json"

START_DATE = date(2020, 1, 1)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 TR-Analyzer/1.0"


def session() -> requests.Session:
    """Session with SSL verification disabled — TWSE/TPEX certs sometimes fail
    'Missing Subject Key Identifier' check on Python 3.13+. Public read-only data,
    no credentials sent."""
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"})
    s.verify = False
    return s


def polite_sleep(seconds: float = 1.2) -> None:
    time.sleep(seconds)


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def parse_roc_date(s: str) -> date:
    """民國日期 '114/05/07' or '1140507' → date."""
    s = s.strip().replace("-", "/")
    if "/" in s:
        y, m, d = s.split("/")
    else:
        y, m, d = s[:-4], s[-4:-2], s[-2:]
    return date(int(y) + 1911, int(m), int(d))


def fmt_iso(d: date) -> str:
    return d.strftime("%Y-%m-%d")
