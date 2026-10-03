// ECharts 包裝：累積報酬多線圖。

const Chart = (() => {
  let chart = null;

  function init() {
    chart = echarts.init(document.getElementById("chart"));
    window.addEventListener("resize", () => chart && chart.resize());
  }

  function render(seriesList) {
    // seriesList: [{name, data: [[d, pct]...], color}]
    const option = {
      animation: false,
      grid: { left: 60, right: 30, top: 50, bottom: 70 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        valueFormatter: v => v == null ? "—" : `${v.toFixed(2)}%`,
      },
      legend: { top: 8, type: "scroll" },
      xAxis: {
        type: "time",
        axisLabel: { formatter: "{yyyy}/{MM}/{dd}" },
      },
      yAxis: {
        type: "value",
        name: "累積報酬 (%)",
        axisLabel: { formatter: "{value}%" },
        splitLine: { lineStyle: { type: "dashed", color: "#e5e7eb" } },
      },
      dataZoom: [
        { type: "inside" },
        { type: "slider", height: 24, bottom: 24 },
      ],
      series: seriesList.map(s => ({
        name: s.name,
        type: "line",
        data: s.data,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: s.benchmark ? 1.5 : 2, type: s.benchmark ? "dashed" : "solid" },
        emphasis: { focus: "series" },
        ...(s.color ? { itemStyle: { color: s.color }, lineStyle: { width: 2, color: s.color, type: s.benchmark ? "dashed" : "solid" } } : {}),
      })),
    };
    chart.setOption(option, { notMerge: true });
  }

  function clear() {
    if (chart) chart.clear();
  }

  return { init, render, clear };
})();
