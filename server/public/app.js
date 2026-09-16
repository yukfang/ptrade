const OPEN_STATUS = new Set([48, 49, 50, 51, 52, 55]);
const CANCEL_STATUS = new Set([53, 54, 57]);

let lastMetaText = "";
let lastSyncText = "";
let lastLadderKey = "";
let lastTick = null;
let lastGoodData = null;
let knownVersion = 0;
let emptyStreak = 0;
let refreshing = false;

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

function tickDigits(tick) {
  return Math.max(0, String(tick).split(".")[1]?.length || 0);
}

function tickScale(tick) {
  return Math.round(1 / tick);
}

function priceToIdx(price, tick) {
  return Math.round(num(price) * tickScale(tick));
}

function idxToPrice(idx, tick) {
  return idx / tickScale(tick);
}

function fmtPriceIdx(idx, tick) {
  return idxToPrice(idx, tick).toFixed(tickDigits(tick));
}

function fmtQty(qty) {
  if (!qty) return "";
  return String(Math.round(qty));
}

function buildLevels(data, tick) {
  const hangs = { buy: new Map(), sell: new Map() };
  const fills = { buy: new Map(), sell: new Map() };
  const cancels = { buy: new Map(), sell: new Map() };
  const idxs = [];

  function add(map, price, qty) {
    if (!qty) return;
    const idx = priceToIdx(price, tick);
    idxs.push(idx);
    map.set(idx, (map.get(idx) || 0) + qty);
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

  if (!idxs.length) return [];

  const min = Math.min(...idxs);
  const max = Math.max(...idxs);
  const levels = [];
  for (let idx = max; idx >= min; idx -= 1) {
    levels.push({
      idx,
      priceLabel: fmtPriceIdx(idx, tick),
      hangBuy: hangs.buy.get(idx) || 0,
      hangSell: hangs.sell.get(idx) || 0,
      fillBuy: fills.buy.get(idx) || 0,
      fillSell: fills.sell.get(idx) || 0,
      cancelBuy: cancels.buy.get(idx) || 0,
      cancelSell: cancels.sell.get(idx) || 0,
    });
  }
  return levels;
}

function rowKey(row) {
  return [
    row.idx,
    row.hangBuy,
    row.hangSell,
    row.fillBuy,
    row.fillSell,
    row.cancelBuy,
    row.cancelSell,
  ].join("|");
}

function ladderFingerprint(levels, tick) {
  return `${tick}::` + levels.map(rowKey).join(";");
}

function tagsHtml(row) {
  const hangs = [];
  const fills = [];
  const cancels = [];
  if (row.hangBuy) hangs.push(`<span class="tag hang buy">买挂 ${fmtQty(row.hangBuy)}</span>`);
  if (row.hangSell) hangs.push(`<span class="tag hang sell">卖挂 ${fmtQty(row.hangSell)}</span>`);
  if (row.fillBuy) fills.push(`<span class="tag fill buy">买成 ${fmtQty(row.fillBuy)}</span>`);
  if (row.fillSell) fills.push(`<span class="tag fill sell">卖成 ${fmtQty(row.fillSell)}</span>`);
  if (row.cancelBuy) cancels.push(`<span class="tag cancel">买撤 ${fmtQty(row.cancelBuy)}</span>`);
  if (row.cancelSell) cancels.push(`<span class="tag cancel">卖撤 ${fmtQty(row.cancelSell)}</span>`);
  return { hangs: hangs.join(""), fills: fills.join(""), cancels: cancels.join("") };
}

function createRowEl(row) {
  const empty = !row.hangBuy && !row.hangSell && !row.fillBuy && !row.fillSell && !row.cancelBuy && !row.cancelSell;
  const tags = tagsHtml(row);
  const el = document.createElement("div");
  el.className = `ladder-row${empty ? " empty" : ""}`;
  el.dataset.idx = String(row.idx);
  el.dataset.key = rowKey(row);
  el.innerHTML = `
    <div class="price">${row.priceLabel}</div>
    <div class="cells hangs">${tags.hangs}</div>
    <div class="cells fills">${tags.fills}</div>
    <div class="cells cancels">${tags.cancels}</div>`;
  return el;
}

function patchRowEl(el, row) {
  const key = rowKey(row);
  if (el.dataset.key === key) return false;
  const empty = !row.hangBuy && !row.hangSell && !row.fillBuy && !row.fillSell && !row.cancelBuy && !row.cancelSell;
  const tags = tagsHtml(row);
  el.className = `ladder-row${empty ? " empty" : ""}`;
  el.dataset.key = key;
  const price = el.querySelector(".price");
  const hangs = el.querySelector(".hangs");
  const fills = el.querySelector(".fills");
  const cancels = el.querySelector(".cancels");
  if (price && price.textContent !== row.priceLabel) price.textContent = row.priceLabel;
  if (hangs && hangs.innerHTML !== tags.hangs) hangs.innerHTML = tags.hangs;
  if (fills && fills.innerHTML !== tags.fills) fills.innerHTML = tags.fills;
  if (cancels && cancels.innerHTML !== tags.cancels) cancels.innerHTML = tags.cancels;
  return true;
}

function renderLadder(levels, tick) {
  const root = document.getElementById("ladder");
  const section = root.closest(".ladder-section");
  const scrollTop = section ? section.scrollTop : 0;
  const fingerprint = ladderFingerprint(levels, tick);

  if (!levels.length) {
    // 偶发空响应不立刻清空，避免整表闪没
    return;
  }

  if (fingerprint === lastLadderKey && tick === lastTick) {
    return;
  }

  const byIdx = new Map();
  for (const el of root.querySelectorAll(".ladder-row[data-idx]")) {
    byIdx.set(el.dataset.idx, el);
  }

  // 去掉「暂无数据」占位
  for (const el of root.querySelectorAll(".ladder-row.empty:not([data-idx])")) {
    el.remove();
  }

  const nextEls = [];
  for (const row of levels) {
    const id = String(row.idx);
    let el = byIdx.get(id);
    if (el) {
      patchRowEl(el, row);
      byIdx.delete(id);
    } else {
      el = createRowEl(row);
    }
    nextEls.push(el);
  }

  // 就地重排/插入，不整表 replaceChildren
  let cursor = root.firstChild;
  for (const el of nextEls) {
    if (cursor === el) {
      cursor = cursor.nextSibling;
      continue;
    }
    root.insertBefore(el, cursor);
  }
  for (const el of byIdx.values()) {
    el.remove();
  }

  if (section) section.scrollTop = scrollTop;
  lastLadderKey = fingerprint;
  lastTick = tick;
}

function formatTs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setLatestSync(ts) {
  const text = ts ? `Latest Syn: ${formatTs(ts)}` : "Latest Syn: --";
  if (text === lastSyncText) return;
  lastSyncText = text;
  const el = document.getElementById("latest-sync");
  if (el) el.textContent = text;
}

function setMeta(text) {
  if (text === lastMetaText) return;
  lastMetaText = text;
  document.getElementById("meta").textContent = text;
}

function rememberVersion(version) {
  const v = Number(version);
  if (Number.isFinite(v) && v > 0) {
    knownVersion = v;
  }
}

function tickValue() {
  const n = Number(document.getElementById("tick").value);
  return n > 0 ? n : 0.001;
}

function isUsableState(data) {
  if (!data || !data.updatedAt) return false;
  const n =
    (data.openOrders || []).length +
    (data.orders || []).length +
    (data.deals || []).length;
  return n > 0;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await fetch(`/api/state?since=${knownVersion}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tick = tickValue();

    if (data.unchanged) {
      emptyStreak = 0;
      rememberVersion(data.version);
      return;
    }

    rememberVersion(data.version);

    if (!isUsableState(data)) {
      emptyStreak += 1;
      if (lastGoodData) {
        // 保留上一帧，只更新提示
        if (emptyStreak >= 3) {
          setMeta("同步中断或暂无数据，仍显示上一帧");
        }
        return;
      }
      if (emptyStreak >= 2) {
        setLatestSync("");
        setMeta("尚未收到 QMT 推送。请在 VM 里实盘启动 qmt_bridge.py");
        const root = document.getElementById("ladder");
        if (!root.querySelector(".ladder-row[data-idx]") && lastLadderKey !== "empty") {
          root.innerHTML = '<div class="ladder-row empty"><span class="price">暂无数据</span></div>';
          lastLadderKey = "empty";
        }
      }
      return;
    }

    emptyStreak = 0;
    lastGoodData = data;
    const open = (data.openOrders || []).length;
    const orders = (data.orders || []).length;
    const deals = (data.deals || []).length;
    setLatestSync(data.updatedAt);
    setMeta(`${data.stock || "-"}  挂盘${open} 委托${orders} 成交${deals}`);
    renderLadder(buildLevels(data, tick), tick);
  } catch (err) {
    emptyStreak += 1;
    if (!lastGoodData) {
      setMeta(`拉取失败: ${err.message}`);
    } else if (emptyStreak >= 3) {
      setMeta(`拉取失败，仍显示上一帧: ${err.message}`);
    }
  } finally {
    refreshing = false;
  }
}

document.getElementById("tick").addEventListener("change", () => {
  lastLadderKey = "";
  if (lastGoodData) {
    renderLadder(buildLevels(lastGoodData, tickValue()), tickValue());
    return;
  }
  knownVersion = 0;
  refresh().catch(() => {});
});

refresh().catch((err) => {
  setMeta(`拉取失败: ${err.message}`);
});
setInterval(() => {
  refresh().catch(() => {});
}, 1000);

(async function showAppVersion() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const h = await res.json();
    const el = document.getElementById("app-version");
    if (el && h.appVersion) el.textContent = "v" + h.appVersion;
  } catch (_err) {
    /* ignore */
  }
})();
