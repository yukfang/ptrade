const STATUS = {
  48: "未报",
  49: "待报",
  50: "已报",
  51: "已报待撤",
  52: "部成待撤",
  53: "部撤",
  54: "已撤",
  55: "部成",
  56: "已成",
  57: "废单",
};

const OPEN_STATUS = new Set([48, 49, 50, 51, 52, 55]);
const CANCEL_STATUS = new Set([53, 54, 57]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optSide(row) {
  const name = String(row.m_strOptName || "");
  if (name.includes("卖")) return "sell";
  if (name.includes("买")) return "buy";
  return "";
}

function statusCode(row) {
  return num(row.m_nOrderStatus || row.status);
}

function orderPrice(row) {
  return num(row.m_dLimitPrice || row.price);
}

function dealPrice(row) {
  return num(row.m_dPrice || row.price);
}

function roundTick(price, tick) {
  return Math.round(price / tick) * tick;
}

function fmtPrice(price, tick) {
  const digits = Math.max(0, String(tick).split(".")[1]?.length || 0);
  return price.toFixed(digits);
}

function fmtQty(qty) {
  if (!qty) return "";
  return String(Math.round(qty));
}

function buildLevels(data, tick) {
  const hangs = { buy: new Map(), sell: new Map() };
  const fills = { buy: new Map(), sell: new Map() };
  const cancels = { buy: new Map(), sell: new Map() };
  const prices = [];

  function add(map, price, qty) {
    if (!qty) return;
    const key = roundTick(price, tick);
    prices.push(key);
    map.set(key, (map.get(key) || 0) + qty);
  }

  const orderRows = data.orders && data.orders.length ? data.orders : data.openOrders || [];
  for (const row of orderRows) {
    const side = optSide(row) || "buy";
    const status = statusCode(row);
    const original = num(row.m_nVolumeTotalOriginal || row.qty);
    const traded = num(row.m_nVolumeTraded);
    const remaining = num(row.m_nVolumeTotal);
    const cancelAmt = num(row.m_dCancelAmount);
    if (OPEN_STATUS.has(status) && remaining) {
      add(hangs[side], orderPrice(row), remaining);
    }
    if (CANCEL_STATUS.has(status) || cancelAmt) {
      add(cancels[side], orderPrice(row), cancelAmt || Math.max(0, original - traded));
    }
  }

  for (const row of data.deals || []) {
    const side = optSide(row) || "buy";
    add(fills[side], dealPrice(row), num(row.m_nVolume || row.qty));
  }

  if (!prices.length) return [];

  const min = roundTick(Math.min(...prices), tick);
  const max = roundTick(Math.max(...prices), tick);
  const levels = [];
  for (let p = max; p >= min - tick / 2; p = roundTick(p - tick, tick)) {
    const key = roundTick(p, tick);
    levels.push({
      price: key,
      hangBuy: hangs.buy.get(key) || 0,
      hangSell: hangs.sell.get(key) || 0,
      fillBuy: fills.buy.get(key) || 0,
      fillSell: fills.sell.get(key) || 0,
      cancelBuy: cancels.buy.get(key) || 0,
      cancelSell: cancels.sell.get(key) || 0,
    });
  }
  return levels;
}

function renderLadder(levels, tick) {
  const root = document.getElementById("ladder");
  if (!levels.length) {
    root.innerHTML = '<div class="ladder-row empty"><span></span><span class="price">暂无数据</span></div>';
    return;
  }
  root.innerHTML = levels
    .map((row) => {
      const empty = !row.hangBuy && !row.hangSell && !row.fillBuy && !row.fillSell && !row.cancelBuy && !row.cancelSell;
      const hangs = [];
      const fills = [];
      const cancels = [];
      if (row.hangBuy) hangs.push(`<span class="tag hang buy">买挂 ${fmtQty(row.hangBuy)}</span>`);
      if (row.hangSell) hangs.push(`<span class="tag hang sell">卖挂 ${fmtQty(row.hangSell)}</span>`);
      if (row.fillBuy) fills.push(`<span class="tag fill buy">买成 ${fmtQty(row.fillBuy)}</span>`);
      if (row.fillSell) fills.push(`<span class="tag fill sell">卖成 ${fmtQty(row.fillSell)}</span>`);
      if (row.cancelBuy) cancels.push(`<span class="tag cancel">买撤 ${fmtQty(row.cancelBuy)}</span>`);
      if (row.cancelSell) cancels.push(`<span class="tag cancel">卖撤 ${fmtQty(row.cancelSell)}</span>`);
      return `<div class="ladder-row${empty ? " empty" : ""}">
        <div class="price">${fmtPrice(row.price, tick)}</div>
        <div class="cells hangs">${hangs.join("")}</div>
        <div class="cells fills">${fills.join("")}</div>
        <div class="cells cancels">${cancels.join("")}</div>
      </div>`;
    })
    .join("");
}

function tickValue() {
  const n = Number(document.getElementById("tick").value);
  return n > 0 ? n : 0.001;
}

async function refresh() {
  const res = await fetch("/api/state");
  const data = await res.json();
  const meta = document.getElementById("meta");
  const tick = tickValue();
  if (!data.updatedAt) {
    meta.textContent = "尚未收到 QMT 推送。请在 VM 里实盘启动 qmt_bridge.py";
  } else {
    const open = (data.openOrders || []).length;
    const orders = (data.orders || []).length;
    const deals = (data.deals || []).length;
    meta.textContent = `最近同步 ${data.updatedAt}  ${data.stock || "-"}  挂盘${open} 委托${orders} 成交${deals}`;
  }
  renderLadder(buildLevels(data, tick), tick);
}

document.getElementById("tick").addEventListener("change", () => {
  refresh().catch(() => {});
});

refresh().catch((err) => {
  document.getElementById("meta").textContent = `拉取失败: ${err.message}`;
});
setInterval(() => {
  refresh().catch(() => {});
}, 1000);
