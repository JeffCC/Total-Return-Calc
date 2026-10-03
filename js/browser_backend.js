// 瀏覽器版後端：不需要 server.py，直接在瀏覽器向 FinMind 下載資料並計算 (給 GitHub Pages 用)。
// 邏輯與 scripts/ondemand.py、server.py 的歷史紀錄相同；回傳格式與 /api/* 一致，main.js 不需區分。
// 資料快取存 IndexedDB、查詢歷史存 localStorage —— 都只在使用者自己的瀏覽器裡。

const BrowserBackend = (() => {
  const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
  const EARLIEST = "2000-01-01";
  const STOCK_LIST_TTL_DAYS = 7;
  const HISTORY_KEY = "trc.history";
  const HISTORY_MAX = 300;
  const QUOTA_MSG = "FinMind 免費查詢額度已滿（每小時約 300 次），請等待約一小時後再查詢。";

  // ------------------------------------------------------------ 日期
  const addDays = (iso, n) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const twNow = () => new Date(Date.now() + 8 * 3600e3);  // 用 UTC 欄位讀台灣時間
  const twToday = () => twNow().toISOString().slice(0, 10);
  // 今天收盤資料約 14:30 後才會出現；之前只能確定抓到昨天
  const safeDataEnd = () => (twNow().getUTCHours() >= 15 ? twToday() : addDays(twToday(), -1));
  const minIso = (a, b) => (a < b ? a : b);
  const maxIso = (a, b) => (a > b ? a : b);

  // ------------------------------------------------------------ IndexedDB key-value
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open("total-return-calc", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(() => null);  // 私密瀏覽等情況 IndexedDB 不可用 → 不快取
    }
    return dbp;
  }
  async function kvGet(key) {
    const d = await db();
    if (!d) return null;
    return new Promise(res => {
      const r = d.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  }
  async function kvSet(key, val) {
    const d = await db();
    if (!d) return;
    return new Promise(res => {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = tx.onerror = () => res();
    });
  }

  // ------------------------------------------------------------ FinMind
  function fetchError(msg, quota = false) {
    const e = new Error(msg);
    e.quota = quota;
    return e;
  }

  async function finmind(dataset, dataId, start, end) {
    const p = new URLSearchParams({ dataset });
    if (dataId) p.set("data_id", dataId);
    if (start) p.set("start_date", start);
    if (end) p.set("end_date", end);
    let res, js;
    try {
      res = await fetch(`${FINMIND_URL}?${p}`);
    } catch (e) {
      throw fetchError(`FinMind 連線失敗 (${dataset})，請檢查網路`);
    }
    try { js = await res.json(); } catch { js = {}; }
    const status = js.status ?? res.status;
    if (status === 402 || res.status === 402 || /upper limit/i.test(js.msg || "")) {
      throw fetchError(QUOTA_MSG, true);
    }
    if (status !== 200) throw fetchError(`FinMind ${dataset} 錯誤 (${status})：${js.msg || ""}`);
    return js.data || [];
  }

  // ------------------------------------------------------------ 股票清單
  async function stockList() {
    const cached = await kvGet("stock_list");
    if (cached) {
      const age = (Date.parse(twToday()) - Date.parse(cached.fetched)) / 86400e3;
      if (age < STOCK_LIST_TTL_DAYS) return cached.stocks;
    }
    let rows;
    try {
      rows = await finmind("TaiwanStockInfo");
    } catch (e) {
      if (cached) return cached.stocks;
      throw e;
    }
    const byCode = new Map();
    for (const r of rows) {
      const code = String(r.stock_id || "").trim();
      if (!code || (r.type !== "twse" && r.type !== "tpex")) continue;
      const prev = byCode.get(code);
      if (!prev || (r.date || "") >= prev._d) {
        byCode.set(code, {
          code, name: r.stock_name || "", market: r.type === "twse" ? "TWSE" : "TPEX",
          industry: r.industry_category || "", _d: r.date || "",
        });
      }
    }
    const stocks = [...byCode.values()].map(({ _d, ...s }) => s).sort((a, b) => a.code.localeCompare(b.code));
    stocks.push({ code: "IR0001", name: "加權報酬指數", market: "INDEX", industry: "指數" });
    await kvSet("stock_list", { fetched: twToday(), stocks });
    return stocks;
  }

  let stockMap = null;
  async function lookup(code) {
    if (!stockMap) stockMap = new Map((await stockList()).map(s => [s.code, s]));
    return stockMap.get(code) || { code, name: "", market: "TWSE" };
  }

  // ------------------------------------------------------------ 下載
  async function fetchPrices(code, start, end) {
    if (code === "IR0001") {
      const rows = await finmind("TaiwanStockTotalReturnIndex", "TAIEX", start, end);
      return rows.filter(r => r.price).map(r => ({ d: r.date, c: +r.price }));
    }
    const rows = await finmind("TaiwanStockPrice", code, start, end);
    return rows.filter(r => r.close).map(r => ({ d: r.date, c: +r.close }));
  }

  let manualEvents = null;
  async function loadManualEvents() {
    if (manualEvents === null) {
      try {
        manualEvents = await (await fetch("data/manual_events.json")).json();
      } catch {
        manualEvents = {};
      }
    }
    return manualEvents;
  }

  async function fetchEvents(code) {
    if (code === "IR0001") return [];
    const [divs, splits, reds] = await Promise.all([
      finmind("TaiwanStockDividendResult", code, EARLIEST),
      finmind("TaiwanStockSplitPrice", code, EARLIEST),
      finmind("TaiwanStockCapitalReductionReferencePrice", code, EARLIEST),
    ]);
    const out = [];
    for (const r of divs) {
      const pc = +r.before_price || 0, rp = +r.reference_price || 0;
      if (pc > 0 && rp > 0) out.push({ date: r.date, prev_close: pc, ref_price: rp, type_label: r.stock_or_cache_dividend || "除權息" });
    }
    for (const r of splits) {
      const pc = +r.before_price || 0, rp = +r.after_price || 0;
      if (pc > 0 && rp > 0) out.push({ date: r.date, prev_close: pc, ref_price: rp, type_label: "split", note: r.type || "" });
    }
    for (const r of reds) {
      const pc = +r.ClosingPriceonTheLastTradingDay || 0, rp = +r.PostReductionReferencePrice || 0;
      if (pc > 0 && rp > 0) out.push({ date: r.date, prev_close: pc, ref_price: rp, type_label: "split", note: "減資：" + (r.ReasonforCapitalReduction || "") });
    }
    // 人工補錄事件；分割若 API 已有 (日期差 7 天內) 則不重複套用
    const manual = (await loadManualEvents())[code] || [];
    for (const m of manual) {
      if (!m || typeof m !== "object") continue;
      const dup = out.some(e => e.type_label === m.type_label &&
        Math.abs(Date.parse(e.date) - Date.parse(m.date)) <= 7 * 86400e3);
      if (!dup) out.push({ date: m.date, prev_close: m.prev_close, ref_price: m.ref_price, type_label: m.type_label, note: m.note || "" });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  // ------------------------------------------------------------ 快取 + 組裝
  function mergeRows(a, b) {
    const m = new Map(a.map(r => [r.d, r]));
    for (const r of b) m.set(r.d, r);
    return [...m.keys()].sort().map(d => m.get(d));
  }

  const inflight = new Map();  // 同一檔同時查詢時排隊，避免重複下載
  function withLock(code, fn) {
    const prev = inflight.get(code) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    inflight.set(code, next);
    return next;
  }

  function ensureData(code, start, end) {
    return withLock(code, async () => {
      end = minIso(end, safeDataEnd());
      const info = await lookup(code);
      const c = (await kvGet("cache:" + code)) ||
        { code, rows: [], from: null, to: null, events: [], events_checked: null };
      c.name = info.name || c.name || "";
      c.market = info.market || c.market || "TWSE";
      const actions = [];
      let changed = false;

      const gaps = [];
      if (c.from === null) gaps.push([start, end]);
      else {
        if (start < c.from) gaps.push([start, addDays(c.from, -1)]);
        if (end > c.to) gaps.push([addDays(c.to, 1), end]);
      }
      for (const [gs, ge] of gaps) {
        if (gs > ge) continue;
        const rows = await fetchPrices(code, gs, ge);
        c.rows = mergeRows(c.rows, rows);
        c.from = c.from ? minIso(gs, c.from) : gs;
        c.to = c.to ? maxIso(ge, c.to) : ge;
        actions.push(`股價 ${gs}~${ge} (FinMind, ${rows.length} 筆)`);
        changed = true;
      }

      if (code !== "IR0001" && c.events_checked !== twToday()) {
        c.events = await fetchEvents(code);
        c.events_checked = twToday();
        actions.push(`除權息/分割/減資事件 (${c.events.length} 筆)`);
        changed = true;
      }

      if (changed && c.rows.length) {  // 代碼錯誤 (完全無資料) 不寫快取
        c.fetched_at = new Date().toISOString();
        await kvSet("cache:" + code, c);
      }
      return { c, actions };
    });
  }

  function buildSeries(c, start, end) {
    const rows = c.rows.filter(r => r.d >= start && r.d <= end);
    const events = (c.events || []).filter(e => e.prev_close > 0 && e.ref_price > 0);
    const n = rows.length;
    const ft = new Array(n).fill(1), fs = new Array(n).fill(1);
    let k = events.length - 1, curT = 1, curS = 1;
    for (let i = n - 1; i >= 0; i--) {
      const d = rows[i].d;
      while (k >= 0 && events[k].date > d) {
        const ratio = events[k].ref_price / events[k].prev_close;
        curT *= ratio;
        if (events[k].type_label === "split") curS *= ratio;
        k--;
      }
      ft[i] = curT; fs[i] = curS;
    }
    const r6 = x => Math.round(x * 1e6) / 1e6;
    const first = rows.length ? rows[0].d : start;
    return {
      code: c.code, name: c.name || "", market: c.market || "",
      rows: rows.map((r, i) => ({ d: r.d, c: r6(r.c * fs[i]), a: r6(r.c * ft[i]) })),
      events: events.filter(e => first < e.date && e.date <= end).map(e => ({
        date: e.date, prev_close: e.prev_close, ref_price: e.ref_price,
        ratio: r6(e.prev_close / e.ref_price), label: e.type_label || "", note: e.note || "",
      })),
    };
  }

  async function series(code, start, end) {
    code = (code || "").trim().toUpperCase();
    if (!code) throw fetchError("未指定代碼");
    start = maxIso(start, EARLIEST);
    if (start > end) throw fetchError("起始日晚於結束日");
    const { c, actions } = await ensureData(code, start, end);
    const out = buildSeries(c, start, end);
    out.downloaded = actions;
    out.fetched_at = c.fetched_at;
    if (!out.rows.length) throw fetchError(`${code} 在 ${start}~${end} 沒有股價資料 (代碼錯誤或尚未上市？)`);
    return out;
  }

  // ------------------------------------------------------------ 查詢歷史 (localStorage)
  function histLoad() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  }
  function histSave(items) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); } catch { /* 無痕模式或空間滿 */ }
    return items;
  }
  function histKey(h) {
    const span = h.range === "CUSTOM" ? `${h.start}~${h.end}` : h.range;
    return [(h.codes || []).join(","), [...(h.benchmarks || [])].sort().join(","), span].join("|");
  }
  function histAdd(entry) {
    let items = histLoad();
    const key = histKey(entry);
    const old = items.find(x => histKey(x) === key);
    items = items.filter(x => histKey(x) !== key);
    entry.id = old ? old.id : Math.random().toString(16).slice(2, 14);
    entry.pinned = !!(old && old.pinned);
    entry.label = (old && old.label) || "";
    entry.count = ((old && old.count) || 0) + 1;
    items.unshift(entry);
    while (items.length > HISTORY_MAX) {  // 優先刪除最舊的未釘選紀錄
      let idx = -1;
      items.forEach((x, i) => { if (!x.pinned) idx = i; });
      if (idx < 0) break;
      items.splice(idx, 1);
    }
    return histSave(items);
  }
  function histPatch(id, patch) {
    const items = histLoad();
    for (const x of items) {
      if (x.id !== id) continue;
      if ("pinned" in patch) x.pinned = !!patch.pinned;
      if ("label" in patch) x.label = String(patch.label).slice(0, 60);
    }
    return histSave(items);
  }
  const histDelete = ids => histSave(histLoad().filter(x => !ids.has(x.id)));

  // ------------------------------------------------------------ 路由 (模擬 server.py 的 /api/*)
  async function handle(path, opts = {}) {
    const u = new URL(path, "http://x");
    const q = Object.fromEntries(u.searchParams);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body || {};
    switch (`${method} ${u.pathname}`) {
      case "GET /api/stocks": return { stocks: await stockList() };
      case "GET /api/series": return series(q.code, q.start, q.end || twToday());
      case "GET /api/history": return { items: histLoad() };
      case "POST /api/history": return { items: histAdd(body) };
      case "PATCH /api/history": return { items: histPatch(q.id, body) };
      case "DELETE /api/history": return { items: histDelete(new Set([q.id])) };
      case "POST /api/history/delete": return { items: histDelete(new Set(body.ids || [])) };
    }
    throw fetchError(`未知的請求：${method} ${u.pathname}`);
  }

  return { handle, QUOTA_MSG };
})();
