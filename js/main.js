// 主程式：查詢時才下載資料，並記錄查詢歷史。
// 兩種模式自動切換：
//   server  — 用 start.bat / server.py 啟動 (本機版，歷史存 userdata/)
//   browser — GitHub Pages 網頁版，直接在瀏覽器向 FinMind 下載 (js/browser_backend.js)

(async function () {
  const MAX_TICKERS = 10;
  const COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2",
                  "#db2777", "#65a30d", "#ea580c", "#4f46e5"];
  const BENCH_COLORS = { "0050": "#64748b", "IR0001": "#94a3b8" };
  const PRESET_MONTHS = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "10Y": 120 };
  const RANGE_LABEL = { CUSTOM: "自訂" };

  const state = {
    stocks: [],
    byCode: new Map(),
    selected: [],
    benchmarks: { "0050": false, "IR0001": false },
    range: "1Y",
    customStart: null,
    customEnd: null,
    history: [],
    currentHistId: null,
    running: false,
    dirty: false,
  };

  const $ = id => document.getElementById(id);
  const statusEl = $("status");
  const hintEl = $("hint");
  Chart.init();

  // ---------------------------------------------------------------- API
  let mode = "browser";
  try {
    const r = await fetch("/api/history", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) mode = "server";
  } catch { /* 沒有 server → 網頁版 */ }

  async function api(path, opts = {}) {
    if (mode === "browser") return BrowserBackend.handle(path, opts);
    const res = await fetch(path, {
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let js;
    try { js = await res.json(); } catch { throw new Error(`伺服器回應錯誤 (${res.status})`); }
    if (!res.ok) {
      const err = new Error(js.error || `HTTP ${res.status}`);
      err.quota = /額度已滿/.test(err.message);
      throw err;
    }
    return js;
  }

  function showNotice(msg) {
    const el = $("notice");
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }

  // 網頁版：顯示模式說明、載入訪客統計 (js/config.js 有設定才會啟用)
  $("footer-mode").textContent = mode === "server"
    ? "本機版：資料快取於 userdata/cache/，查詢歷史存於 userdata/history.json。"
    : "網頁版：資料快取與查詢歷史只存在你自己的瀏覽器裡（換瀏覽器或清除瀏覽資料就會消失），不會上傳。使用 FinMind 免費額度，每小時約 300 次。";
  statusEl.dataset.mode = mode;
  const gc = (window.SITE_CONFIG || {}).goatcounter;
  if (mode === "browser" && gc) {
    const sc = document.createElement("script");
    sc.async = true;
    sc.src = "https://gc.zgo.at/count.js";
    sc.dataset.goatcounter = `https://${gc}.goatcounter.com/count`;
    document.head.appendChild(sc);
  }
  function countEvent(name) {
    try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); } catch { /* 統計失敗不影響使用 */ }
  }

  function setHint(msg, cls = "") {
    hintEl.textContent = msg;
    hintEl.className = "hint " + cls;
  }

  // ---------------------------------------------------------------- 初始化
  const today = new Date();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  $("custom-start").value = `${today.getFullYear()}-01-01`;
  $("custom-end").value = iso(today);

  try {
    statusEl.textContent = "載入股票清單…";
    const js = await api("/api/stocks");
    state.stocks = js.stocks;
    state.stocks.forEach(s => state.byCode.set(s.code, s));
    statusEl.textContent = `${mode === "server" ? "本機版" : "網頁版"} · ${state.stocks.length} 檔可查詢`;
  } catch (e) {
    statusEl.textContent = "股票清單載入失敗";
    if (e.quota) showNotice(e.message);
    else setHint("股票清單載入失敗：" + e.message + "（仍可直接輸入代碼查詢）", "err");
  }

  // ---------------------------------------------------------------- 搜尋
  const input = $("ticker-input");
  const sugg = $("ticker-suggest");
  let suggestActive = -1;

  function matchStocks(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const exact = [], prefix = [], other = [];
    for (const t of state.stocks) {
      if (state.selected.includes(t.code) || t.market === "INDEX") continue;
      const c = t.code.toLowerCase(), n = (t.name || "").toLowerCase();
      if (c === q) exact.push(t);
      else if (c.startsWith(q)) prefix.push(t);
      else if (n.includes(q)) other.push(t);
    }
    return [...exact, ...prefix, ...other].slice(0, 30);
  }

  function renderSuggest(query) {
    const q = query.trim();
    if (!q) { sugg.classList.add("hidden"); return; }
    const matches = matchStocks(q);
    if (!matches.length) {
      sugg.innerHTML = `<div class="suggest-item" data-code="${escape(q.toUpperCase())}">
        <span class="code">${escape(q.toUpperCase())}</span>
        <span class="name">— 清單中找不到，仍直接嘗試下載</span></div>`;
    } else {
      sugg.innerHTML = matches.map(t => `
        <div class="suggest-item" data-code="${t.code}">
          <span class="code">${t.code}</span>
          <span class="name">${escape(t.name)}</span>
          <span class="market">${t.market === "TWSE" ? "上市" : "上櫃"}</span>
        </div>`).join("");
    }
    suggestActive = 0;
    updateActive(sugg.querySelectorAll(".suggest-item"));
    sugg.classList.remove("hidden");
  }

  // 多檔分隔：半形/全形逗號、頓號、空格
  const SEP = /[\s,，、]+/;
  // 把輸入框中的代碼逐一加入；all=false 時保留最後一段 (還在打字中)
  function commitTokens(all) {
    const parts = input.value.split(SEP);
    const rest = all ? "" : parts.pop();
    for (const p of parts.filter(Boolean)) {
      if (addTicker(resolveCode(p)) === "full") break;
    }
    input.value = rest;
  }

  input.addEventListener("input", e => {
    // 打到分隔符號時，前面的代碼直接加入 (中文輸入法組字中不處理)
    if (!e.isComposing && SEP.test(input.value)) commitTokens(false);
    renderSuggest(input.value);
  });
  input.addEventListener("focus", e => renderSuggest(e.target.value));
  input.addEventListener("blur", () => setTimeout(() => sugg.classList.add("hidden"), 200));
  input.addEventListener("keydown", e => {
    const items = sugg.querySelectorAll(".suggest-item");
    if (e.key === "ArrowDown") {
      suggestActive = Math.min(items.length - 1, suggestActive + 1);
      updateActive(items); e.preventDefault();
    } else if (e.key === "ArrowUp") {
      suggestActive = Math.max(0, suggestActive - 1);
      updateActive(items); e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!input.value.trim()) { run(); return; }
      // 支援一次貼上多檔：2330 0056,00878
      if (SEP.test(input.value.trim())) {
        commitTokens(true);
        clearInput();
      } else if (items[suggestActive]) {
        items[suggestActive].click();
      }
    } else if (e.key === "Escape") {
      sugg.classList.add("hidden");
    }
  });
  function updateActive(items) {
    items.forEach((el, i) => el.classList.toggle("active", i === suggestActive));
  }
  function resolveCode(p) {
    const up = p.toUpperCase();
    if (state.byCode.has(up)) return up;
    const m = matchStocks(p);
    return m.length ? m[0].code : up;
  }
  function clearInput() {
    input.value = "";
    sugg.classList.add("hidden");
    input.focus();
  }
  sugg.addEventListener("click", e => {
    const item = e.target.closest(".suggest-item");
    if (!item) return;
    addTicker(item.dataset.code);
    clearInput();
  });

  function markDirty() {
    state.dirty = true;
    state.currentHistId = null;
    renderHistory();
    if (state.selected.length) setHint("條件已變更，按「查詢」或 Enter 開始下載並計算", "dirty");
  }

  function addTicker(code) {
    if (!code || state.selected.includes(code)) return;
    if (state.selected.length >= MAX_TICKERS) { alert(`最多 ${MAX_TICKERS} 檔`); return "full"; }
    state.selected.push(code);
    renderChips();
    markDirty();
  }

  function removeTicker(code) {
    state.selected = state.selected.filter(c => c !== code);
    renderChips();
    markDirty();
  }

  function nameOf(code) {
    const t = state.byCode.get(code);
    return t ? t.name : "";
  }

  function renderChips(status = {}) {
    const chips = $("selected-tickers");
    chips.innerHTML = state.selected.map((code, i) => `
      <span class="chip ${status[code] || ""}" data-code="${code}" title="${escape(status[code + ":msg"] || "拖拉可調整順序")}">
        <span class="grip">⋮⋮</span><span class="ord">${i + 1}.</span>
        ${code} ${escape(nameOf(code))}<span class="close" data-code="${code}">×</span>
      </span>`).join("");
    chips.querySelectorAll(".close").forEach(el => {
      el.addEventListener("click", () => removeTicker(el.dataset.code));
    });
    $("chips-tip").classList.toggle("hidden", !(sortable && state.selected.length > 1));
  }

  // 拖拉調整標的順序 (SortableJS；CDN 載入失敗時就只是不能拖拉)
  const sortable = window.Sortable ? Sortable.create($("selected-tickers"), {
    animation: 150,
    filter: ".close", preventOnFilter: false,
    delay: 150, delayOnTouchOnly: true,   // 手機上長按才拖拉，不影響捲動
    ghostClass: "drag-ghost", chosenClass: "drag-chosen",
    onEnd: () => {
      const order = [...$("selected-tickers").children].map(el => el.dataset.code);
      if (order.join() === state.selected.join()) return;
      state.selected = order;
      renderChips();
      markDirty();
    },
  }) : null;

  // ---------------------------------------------------------------- 基準 / 區間
  for (const k of ["0050", "IR0001"]) {
    $("bench-" + k).addEventListener("change", e => {
      state.benchmarks[k] = e.target.checked;
      if (state.selected.length) run(); else markDirty();
    });
  }

  function setRangeUI() {
    document.querySelectorAll(".range-buttons button").forEach(b =>
      b.classList.toggle("active", b.dataset.range === state.range));
    if (state.range === "CUSTOM") {
      $("custom-start").value = state.customStart;
      $("custom-end").value = state.customEnd;
    }
  }

  document.querySelectorAll(".range-buttons button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.range = btn.dataset.range;
      state.customStart = state.customEnd = null;
      setRangeUI();
      if (state.selected.length) run();
    });
  });
  $("custom-apply").addEventListener("click", () => {
    const s = $("custom-start").value, e = $("custom-end").value;
    if (!s || !e) { alert("請選擇起始與結束日"); return; }
    if (s > e) { alert("起始日不可晚於結束日"); return; }
    state.customStart = s; state.customEnd = e; state.range = "CUSTOM";
    setRangeUI();
    if (state.selected.length) run();
  });
  $("run").addEventListener("click", () => {
    if (input.value.trim()) { commitTokens(true); clearInput(); }  // 輸入框還有代碼 → 先加入
    run();
  });

  function computeRange() {
    if (state.range === "CUSTOM") return [state.customStart, state.customEnd];
    const end = new Date();
    let start;
    if (state.range === "YTD") {
      start = new Date(end.getFullYear(), 0, 1);
    } else {
      start = new Date(end);
      start.setMonth(start.getMonth() - (PRESET_MONTHS[state.range] || 12));
    }
    return [iso(start), iso(end)];
  }

  // ---------------------------------------------------------------- 查詢
  async function run({ record = true } = {}) {
    if (state.running) return;
    const codes = [...state.selected];
    if (!codes.length) { setHint("請先加入至少 1 檔標的", "err"); return; }
    const benchCodes = ["0050", "IR0001"].filter(k => state.benchmarks[k] && !codes.includes(k));
    const [start, end] = computeRange();

    state.running = true;
    $("run").disabled = true;
    if (sortable) sortable.option("disabled", true);
    const chipStatus = Object.fromEntries(codes.map(c => [c, "loading"]));
    renderChips(chipStatus);
    setHint(`下載 ${codes.length + benchCodes.length} 檔 ${start} ~ ${end} 資料中…`);
    const t0 = performance.now();

    const all = [...codes.map(c => ({ code: c, isBench: false })), ...benchCodes.map(c => ({ code: c, isBench: true }))];
    const results = await Promise.all(all.map(async item => {
      try {
        const d = await api(`/api/series?code=${encodeURIComponent(item.code)}&start=${start}&end=${end}`);
        if (!item.isBench) { delete chipStatus[item.code]; renderChips(chipStatus); }
        return { ...d, isBench: item.isBench };
      } catch (e) {
        if (!item.isBench) {
          chipStatus[item.code] = "error";
          chipStatus[item.code + ":msg"] = e.message;
          renderChips(chipStatus);
        }
        return { code: item.code, isBench: item.isBench, error: e.message, quota: !!e.quota };
      }
    }));

    state.running = false;
    $("run").disabled = false;
    if (sortable) sortable.option("disabled", false);
    state.dirty = false;

    const ok = results.filter(r => !r.error && r.rows && r.rows.length >= 2);
    const errs = results.filter(r => r.error);
    const quotaHit = errs.some(r => r.quota);
    showNotice(quotaHit ? "⚠ " + BrowserBackend.QUOTA_MSG + "（已快取的標的仍可查詢）" : "");
    if (results.some(r => !r.error)) countEvent("query");
    const downloaded = results.flatMap(r => (r.downloaded || []).map(x => `${r.code} ${x}`));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    let msg = `完成 (${secs}s)` + (downloaded.length ? `，新下載：${downloaded.length} 項` : "，全部使用快取");
    if (errs.length) msg += `　⚠ ${errs.map(e => `${e.code}: ${e.error}`).join("；")}`;
    setHint(msg, errs.length ? "err" : "");
    if (downloaded.length) console.info("下載明細", downloaded);

    for (const r of ok) {
      if (r.name && !state.byCode.has(r.code)) state.byCode.set(r.code, { code: r.code, name: r.name, market: r.market });
    }
    renderChips(chipStatus);
    const summaryRows = render(ok, start, end);

    const mainResults = summaryRows.filter(r => !r.isBench);
    if (record && mainResults.length) {
      const entry = {
        ts: new Date().toISOString(),
        codes, names: Object.fromEntries(codes.map(c => [c, nameOf(c)])),
        benchmarks: benchCodes,
        range: state.range, start, end,
        results: summaryRows.map(r => ({
          code: r.code, name: r.name, isBench: r.isBench,
          start: r.start, end: r.end,
          totalReturn: r.totalReturn, priceReturn: r.priceReturn, cagr: r.cagr,
        })),
      };
      try {
        const js = await api("/api/history", { method: "POST", body: entry });
        state.history = js.items;
        const key = histKey(entry);
        const cur = state.history.find(h => histKey(h) === key);
        state.currentHistId = cur ? cur.id : null;
        renderHistory();
      } catch (e) {
        console.warn("history save failed", e);
      }
    }
  }

  function render(datasets, start, end) {
    const seriesList = [];
    const summaryRows = [];
    let mainIdx = 0;
    for (const d of datasets) {
      const sliced = Calc.slice(d.rows, start, end);
      if (sliced.length < 2) continue;
      const color = d.isBench ? (BENCH_COLORS[d.code] || "#94a3b8") : COLORS[mainIdx++ % COLORS.length];
      seriesList.push({
        name: `${d.code} ${d.name || ""}`.trim(),
        data: Calc.cumReturnSeries(sliced, true), color, benchmark: d.isBench,
      });
      summaryRows.push({
        ...Calc.summarize(sliced),
        code: d.code, name: d.name, market: d.market, isBench: d.isBench,
        events: d.events || [],
        firstAvail: d.rows[0].d,
      });
    }
    Chart.render(seriesList);
    renderSummary(summaryRows, start);
    return summaryRows;
  }

  const fmtPct = (v, p = 2) => v == null ? "—" : (v * 100).toFixed(p) + "%";
  const cls = v => v == null ? "" : (v >= 0 ? "pos" : "neg");
  const MARKET = { TWSE: "上市", TPEX: "上櫃", INDEX: "指數" };

  // ---- 表格排序：點欄位標題 → 遞減 ▼ → 遞增 ▲ → 恢復原順序
  const SORT_COLS = [
    { key: "code", label: "標的", get: r => r.code, text: true },
    { key: "market", label: "市場", get: r => MARKET[r.market] || r.market || "", text: true },
    { key: "start", label: "起點", get: r => r.start, text: true },
    { key: "end", label: "終點", get: r => r.end, text: true },
    { key: "days", label: "天數", get: r => r.days },
    { key: "totalReturn", label: "含息報酬", get: r => r.totalReturn },
    { key: "priceReturn", label: "純價格報酬", get: r => r.priceReturn },
    { key: "cagr", label: "年化(含息)", get: r => r.cagr },
    { key: "events", label: "區間除權息", get: r => r.events.length },
  ];
  const sortState = { key: null, dir: 0 };  // dir: -1 遞減, 1 遞增, 0 原順序
  let lastSummary = { rows: [], reqStart: null };

  function renderSortHeader() {
    const tr = document.querySelector("#summary-table thead tr");
    tr.innerHTML = SORT_COLS.map(c => {
      const on = sortState.key === c.key && sortState.dir !== 0;
      const up = on && sortState.dir === 1, down = on && sortState.dir === -1;
      return `<th class="sortable ${on ? "sorted" : ""}" data-key="${c.key}" title="點擊排序">
        ${c.label}<span class="sort-arrows"><i class="${up ? "on" : ""}">▲</i><i class="${down ? "on" : ""}">▼</i></span></th>`;
    }).join("");
  }
  renderSortHeader();

  document.querySelector("#summary-table thead").addEventListener("click", e => {
    const th = e.target.closest("th[data-key]");
    if (!th) return;
    const key = th.dataset.key;
    const col = SORT_COLS.find(c => c.key === key);
    if (sortState.key !== key) {
      sortState.key = key;
      sortState.dir = col.text ? 1 : -1;  // 數字欄先由大到小，文字欄先由小到大
    } else {
      const first = col.text ? 1 : -1;
      sortState.dir = sortState.dir === first ? -first : sortState.dir === -first ? 0 : first;
    }
    renderSortHeader();
    renderSummary(lastSummary.rows, lastSummary.reqStart);
  });

  function sortedRows(rows) {
    const col = SORT_COLS.find(c => c.key === sortState.key);
    if (!col || !sortState.dir) return rows;
    return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return ia - ib;
      if (va == null) return 1;   // 無資料永遠排最後
      if (vb == null) return -1;
      const c = col.text ? String(va).localeCompare(String(vb), "zh-Hant") : va - vb;
      return c ? c * sortState.dir : ia - ib;
    }).map(([r]) => r);
  }

  function renderSummary(rows, reqStart) {
    lastSummary = { rows, reqStart };
    const tbody = document.querySelector("#summary-table tbody");
    tbody.innerHTML = sortedRows(rows).map(r => {
      // 起點比要求的晚超過 7 天 → 標記 (區間內才上市)
      const late = (new Date(r.start) - new Date(reqStart)) / 86400000 > 7;
      const evTip = r.events.map(e => {
        const kind = e.label === "split" ? (e.note || "分割/減資") : e.label;
        const amt = e.label === "split" ? `${e.prev_close}→${e.ref_price}` : `約 ${(e.prev_close - e.ref_price).toFixed(4).replace(/\.?0+$/, "")} 元`;
        return `${e.date} ${kind} ${amt}`;
      }).join("\n");
      return `<tr class="${late ? "missing-data" : ""}" ${late ? `title="資料自 ${r.firstAvail} 起 (區間內才上市或無交易)"` : ""}>
        <td>${r.isBench ? `${r.code} (基準)` : r.code} ${escape(r.name || "")}</td>
        <td>${MARKET[r.market] || r.market || ""}</td>
        <td>${r.start}</td>
        <td>${r.end}</td>
        <td>${r.days}</td>
        <td class="${cls(r.totalReturn)}">${fmtPct(r.totalReturn)}</td>
        <td class="${cls(r.priceReturn)}">${fmtPct(r.priceReturn)}</td>
        <td class="${cls(r.cagr)}">${fmtPct(r.cagr)}</td>
        <td>${r.events.length ? `<span class="ev-cell" title="${escape(evTip)}">${r.events.length} 次</span>` : "—"}</td>
      </tr>`;
    }).join("");
  }

  // ---------------------------------------------------------------- 歷史
  function histKey(h) {
    const span = h.range === "CUSTOM" ? `${h.start}~${h.end}` : h.range;
    return [h.codes.join(","), [...(h.benchmarks || [])].sort().join(","), span].join("|");
  }

  async function loadHistory() {
    try {
      state.history = (await api("/api/history")).items;
    } catch {
      state.history = [];
    }
    renderHistory();
  }

  $("history-filter").addEventListener("input", renderHistory);

  function rangeText(h) {
    if (h.range === "CUSTOM") return `${h.start} ~ ${h.end}`;
    return `${RANGE_LABEL[h.range] || h.range}（當時 ${h.start} ~ ${h.end}）`;
  }

  function fmtTime(isoStr) {
    const d = new Date(isoStr);
    return `${iso(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function historyItemHTML(h) {
    const names = h.codes.map(c => `${c} ${escape((h.names || {})[c] || nameOf(c))}`).join("、");
    const bench = (h.benchmarks || []).length ? `｜基準 ${h.benchmarks.join("、")}` : "";
    const res = (h.results || []).map(r =>
      `<span>${r.code}${r.isBench ? "(基準)" : ""} <b class="${cls(r.totalReturn)}">${fmtPct(r.totalReturn, 1)}</b></span>`).join("");
    const checked = selectedHist.has(h.id);
    return `<div class="h-item ${h.pinned ? "pinned" : ""} ${h.label ? "named" : ""} ${h.id === state.currentHistId ? "current" : ""} ${checked ? "checked" : ""}" data-id="${h.id}">
      <input type="checkbox" class="h-check" data-act="check" ${checked ? "checked" : ""} title="選取 (可批次清除)" />
      <span class="h-star" data-act="pin" title="${h.pinned ? "取消釘選" : "釘選 (常用組合，如：我的庫存)"}">★</span>
      <div class="h-main">
        <div class="h-title">${h.label ? `<span class="h-label">${escape(h.label)}</span>` : ""}${names}</div>
        <div class="h-meta">${rangeText(h)}${bench}｜查詢於 ${fmtTime(h.ts)}${h.count > 1 ? `｜共 ${h.count} 次` : ""}</div>
        <div class="h-results">${res}</div>
      </div>
      <div class="h-actions">
        <button class="rerun" data-act="rerun" title="以今天為終點重新下載並計算 (自訂區間則用原日期)">重新查詢</button>
        <button data-act="load" title="只把標的帶入上方，不立即查詢">帶入</button>
        <button data-act="label">命名</button>
        <button data-act="del">刪除</button>
      </div>
    </div>`;
  }

  // 批次選取：只記 id；紀錄被刪掉後自動剔除
  const selectedHist = new Set();

  function visibleHistory() {
    const f = $("history-filter").value.trim().toLowerCase();
    const match = h => !f || [h.label || "", ...h.codes, ...Object.values(h.names || {})]
      .some(s => String(s).toLowerCase().includes(f));
    return state.history.filter(match);
  }

  function renderHistory() {
    const alive = new Set(state.history.map(h => h.id));
    for (const id of [...selectedHist]) if (!alive.has(id)) selectedHist.delete(id);

    const items = visibleHistory();
    const pinned = items.filter(h => h.pinned);
    const named = items.filter(h => !h.pinned && h.label);
    const rest = items.filter(h => !h.pinned && !h.label);
    const group = (title, arr) => arr.length
      ? `<div class="history-group-title">${title}</div>` + arr.map(historyItemHTML).join("") : "";
    $("history-pinned").innerHTML = group("★ 釘選組合", pinned) + group("🏷 已命名", named);
    $("history-list").innerHTML = ((pinned.length || named.length) && rest.length ? `<div class="history-group-title">最近查詢</div>` : "") +
      (rest.length ? rest.map(historyItemHTML).join("")
        : (pinned.length || named.length) ? "" :
          `<div class="h-empty">${state.history.length ? "沒有符合的紀錄" : "尚無查詢紀錄。查詢後會自動記錄在這裡，可按 ★ 釘選常用組合（例如自己的庫存）。"}</div>`);
    renderBulkBar();
  }

  function renderBulkBar() {
    const n = selectedHist.size;
    $("hist-clear").textContent = n ? `清除選取 (${n})` : "清除選取";
    $("hist-clear").disabled = !n;
    $("hist-none").disabled = !n;
  }

  // 全選：只選目前篩選下「未命名、未釘選」的紀錄；已命名 / 釘選的請手動勾選或個別刪除
  $("hist-all").addEventListener("click", () => {
    const targets = visibleHistory().filter(h => !h.label && !h.pinned);
    targets.forEach(h => selectedHist.add(h.id));
    renderHistory();
    if (!targets.length) alert("沒有可全選的紀錄（已命名或釘選的紀錄不會被全選）");
  });
  $("hist-none").addEventListener("click", () => {
    selectedHist.clear();
    renderHistory();
  });
  $("hist-clear").addEventListener("click", async () => {
    const ids = [...selectedHist];
    if (!ids.length) return;
    const protectedN = state.history.filter(h => selectedHist.has(h.id) && (h.label || h.pinned)).length;
    const msg = `確定清除 ${ids.length} 筆查詢紀錄？此動作無法復原。` +
      (protectedN ? `\n\n⚠ 其中 ${protectedN} 筆是已命名或釘選的紀錄（你手動勾選的）。` : "");
    if (!confirm(msg)) return;
    try {
      state.history = (await api("/api/history/delete", { method: "POST", body: { ids } })).items;
      selectedHist.clear();
      renderHistory();
    } catch (err) {
      alert("清除失敗：" + err.message);
    }
  });

  function applyHistory(h) {
    state.selected = [...h.codes];
    for (const [c, n] of Object.entries(h.names || {})) {
      if (n && !state.byCode.has(c)) state.byCode.set(c, { code: c, name: n });
    }
    for (const k of ["0050", "IR0001"]) {
      state.benchmarks[k] = (h.benchmarks || []).includes(k);
      $("bench-" + k).checked = state.benchmarks[k];
    }
    state.range = h.range;
    if (h.range === "CUSTOM") { state.customStart = h.start; state.customEnd = h.end; }
    setRangeUI();
    renderChips();
  }

  document.querySelector(".history").addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !btn.closest(".h-item")) return;
    const id = btn.closest(".h-item").dataset.id;
    const h = state.history.find(x => x.id === id);
    if (!h) return;
    const act = btn.dataset.act;
    try {
      if (act === "check") {
        if (btn.checked) selectedHist.add(id); else selectedHist.delete(id);
        btn.closest(".h-item").classList.toggle("checked", btn.checked);
        renderBulkBar();
      } else if (act === "rerun") {
        applyHistory(h);
        window.scrollTo({ top: 0, behavior: "smooth" });
        await run();
      } else if (act === "load") {
        applyHistory(h);
        markDirty();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (act === "pin") {
        state.history = (await api(`/api/history?id=${id}`, { method: "PATCH", body: { pinned: !h.pinned } })).items;
        renderHistory();
      } else if (act === "label") {
        const label = prompt("為這組查詢命名（例如：我的庫存、高股息比較）", h.label || "");
        if (label === null) return;
        state.history = (await api(`/api/history?id=${id}`, { method: "PATCH", body: { label: label.trim() } })).items;
        renderHistory();
      } else if (act === "del") {
        if (!confirm(`刪除這筆紀錄？\n${h.label || h.codes.join("、")}`)) return;
        state.history = (await api(`/api/history?id=${id}`, { method: "DELETE" })).items;
        renderHistory();
      }
    } catch (err) {
      alert("操作失敗：" + err.message);
    }
  });

  function escape(s) {
    return String(s || "").replace(/[<>&"']/g, c => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  await loadHistory();

  // 開啟時：自動查詢第一組釘選組合 (沒有則最近一次查詢)，不另外新增歷史紀錄
  const first = state.history.find(h => h.pinned) || state.history[0];
  if (first) {
    applyHistory(first);
    run({ record: false }).then(() => { state.currentHistId = first.id; renderHistory(); });
  } else {
    setHint("輸入代碼加入標的後按「查詢」，系統才會即時下載該標的資料");
  }
})();
