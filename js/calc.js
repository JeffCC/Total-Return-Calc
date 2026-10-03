// 報酬率計算與區間切片。

const Calc = (() => {
  // 用 binary search 找 >= date 的最早 index
  function findStartIdx(rows, dateStr) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].d < dateStr) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 用 binary search 找 <= date 的最晚 index
  function findEndIdx(rows, dateStr) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].d <= dateStr) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  // 區間切片 → 回 [{d, c, a}, ...] (inclusive)
  function slice(rows, startStr, endStr) {
    if (!rows || !rows.length) return [];
    const s = findStartIdx(rows, startStr);
    const e = findEndIdx(rows, endStr);
    if (s > e) return [];
    return rows.slice(s, e + 1);
  }

  // 計算 normalized 累積報酬序列：以區間第一筆 a 為基準 0%
  function cumReturnSeries(rows, useAdj = true) {
    if (!rows.length) return [];
    const base = useAdj ? rows[0].a : rows[0].c;
    return rows.map(r => {
      const v = useAdj ? r.a : r.c;
      return [r.d, ((v / base) - 1) * 100];
    });
  }

  // 區間總報酬 + 年化
  function summarize(rows) {
    if (rows.length < 2) return null;
    const startA = rows[0].a, endA = rows[rows.length - 1].a;
    const startC = rows[0].c, endC = rows[rows.length - 1].c;
    const totalA = endA / startA - 1;
    const totalC = endC / startC - 1;
    const days = (new Date(rows[rows.length - 1].d) - new Date(rows[0].d)) / 86400000;
    const years = days / 365.25;
    const cagr = years >= 1 / 365 ? Math.pow(1 + totalA, 1 / years) - 1 : null;
    return {
      start: rows[0].d, end: rows[rows.length - 1].d,
      days: Math.round(days),
      totalReturn: totalA, priceReturn: totalC, cagr,
    };
  }

  // 區間定義 → [startStr, endStr]
  // datasets: [{rows}], so we can find common max range
  function rangeFromPreset(preset, datasets) {
    if (!datasets.length) return [null, null];
    // 終點：所有資料集的最早結束日 (取交集)
    let end = datasets[0].rows[datasets[0].rows.length - 1].d;
    for (const d of datasets) {
      const e = d.rows[d.rows.length - 1].d;
      if (e < end) end = e;
    }
    const endDate = new Date(end);
    let start;
    if (preset === "MAX") {
      // 取所有資料集最晚的起始日 (交集)
      let s = datasets[0].rows[0].d;
      for (const d of datasets) {
        const ss = d.rows[0].d;
        if (ss > s) s = ss;
      }
      return [s, end];
    }
    if (preset === "YTD") {
      start = `${endDate.getFullYear()}-01-01`;
    } else {
      const map = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 };
      const months = map[preset] || 12;
      const d = new Date(endDate);
      d.setMonth(d.getMonth() - months);
      start = d.toISOString().slice(0, 10);
    }
    // 與資料集交集
    let actualStart = start;
    for (const ds of datasets) {
      const ss = ds.rows[0].d;
      if (ss > actualStart) actualStart = ss;
    }
    return [actualStart, end];
  }

  return { slice, cumReturnSeries, summarize, rangeFromPreset, findStartIdx, findEndIdx };
})();
