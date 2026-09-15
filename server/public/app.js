const PREFERRED = [
  "m_strInstrumentName",
  "code",
  "m_strOptName",
  "side",
  "price",
  "qty",
  "status",
  "time",
  "date",
  "trade_id",
  "order_id",
  "m_dCommission",
];

function keysFor(rows) {
  const found = new Set();
  for (const row of rows) {
    Object.keys(row || {}).forEach((key) => found.add(key));
  }
  const preferred = PREFERRED.filter((key) => found.has(key));
  const rest = [...found].filter((key) => !preferred.includes(key)).sort();
  return preferred.concat(rest).slice(0, 12);
}

function renderTable(table, rows) {
  if (!rows.length) {
    table.innerHTML = "<tbody><tr><td>暂无数据</td></tr></tbody>";
    return;
  }
  const keys = keysFor(rows);
  const head = keys.map((key) => `<th>${key}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = keys.map((key) => `<td>${row[key] == null ? "" : row[key]}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

async function refresh() {
  const res = await fetch("/api/state");
  const data = await res.json();
  const meta = document.getElementById("meta");
  if (!data.updatedAt) {
    meta.textContent = "尚未收到 QMT 推送。请在 VM 里实盘启动 qmt_bridge.py";
  } else {
    meta.textContent = `最近同步 ${data.updatedAt}  股票 ${data.stock || "-"}  账号已绑定`;
  }
  document.getElementById("open-count").textContent = (data.openOrders || []).length;
  document.getElementById("order-count").textContent = (data.orders || []).length;
  document.getElementById("deal-count").textContent = (data.deals || []).length;
  renderTable(document.getElementById("open-table"), data.openOrders || []);
  renderTable(document.getElementById("order-table"), data.orders || []);
  renderTable(document.getElementById("deal-table"), data.deals || []);
}

refresh().catch((err) => {
  document.getElementById("meta").textContent = `拉取失败: ${err.message}`;
});
setInterval(() => {
  refresh().catch(() => {});
}, 1000);
