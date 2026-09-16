const OPEN_STATUS = new Set([48, 49, 50, 51, 52, 55]);
const CANCEL_STATUS = new Set([53, 54, 57]);
const TICK = 0.001;

let lastMetaText = "";
let lastSyncText = "";
let lastLadderKey = "";
let lastQuoteKey = "";
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

function itemsKey(items) {
  return (items || []).map((it) => `${it.side}:${it.id}:${it.qty}`).join(",");
}

function buildLevels(data, tick) {
  const hangs = { buy: new Map(), sell: new Map() };
  const fills = { buy: new Map(), sell: new Map() };
  const cancels = { buy: new Map(), sell: new Map() };
  const idxs = [];

  function pushItem(map, price, item, mergeById) {
    if (!item.qty) return;
    const idx = priceToIdx(price, tick);
    idxs.push(idx);
    const list = map.get(idx) || [];
    if (mergeById && item.id) {
      const existing = list.find((x) => x.id === item.id && x.side === item.side);
      if (existing) {
        existing.qty += item.qty;
        map.set(idx, list);
        return;
      }
    }
    list.push(item);
    map.set(idx, list);
  }

  function addCancel(map, price, qty) {
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
    const orderId = String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
    if (OPEN_STATUS.has(status) && remaining) {
      pushItem(hangs[side], orderPrice(row), { qty: remaining, id: orderId, side }, false);
    }
    if (CANCEL_STATUS.has(status) || cancelAmt) {
      addCancel(cancels[side], orderPrice(row), cancelAmt || Math.max(0, original - traded));
    }
  }

  for (const row of data.deals || []) {
    const side = optSide(row) || "buy";
    const orderId = String(row.order_id || row.m_strOrderSysID || row.m_strOrderRef || "");
    pushItem(
      fills[side],
      dealPrice(row),
      { qty: num(row.m_nVolume || row.qty), id: orderId, side },
      true
    );
  }

  if (num(data.bid1) > 0) idxs.push(priceToIdx(data.bid1, tick));
  if (num(data.ask1) > 0) idxs.push(priceToIdx(data.ask1, tick));

  if (!idxs.length) return [];

  const min = Math.min(...idxs);
  const max = Math.max(...idxs);
  const levels = [];
  for (let idx = max; idx >= min; idx -= 1) {
    levels.push({
      idx,
      priceLabel: fmtPriceIdx(idx, tick),
      hangBuy: hangs.buy.get(idx) || [],
      hangSell: hangs.sell.get(idx) || [],
      fillBuy: fills.buy.get(idx) || [],
      fillSell: fills.sell.get(idx) || [],
      cancelBuy: cancels.buy.get(idx) || 0,
      cancelSell: cancels.sell.get(idx) || 0,
    });
  }
  return levels;
}

function rowEmpty(row) {
  return (
    !row.hangBuy.length &&
    !row.hangSell.length &&
    !row.fillBuy.length &&
    !row.fillSell.length &&
    !row.cancelBuy &&
    !row.cancelSell
  );
}

function rowKey(row) {
  return [
    row.idx,
    itemsKey(row.hangBuy),
    itemsKey(row.hangSell),
    itemsKey(row.fillBuy),
    itemsKey(row.fillSell),
    row.cancelBuy,
    row.cancelSell,
  ].join("|");
}

function ladderFingerprint(levels, tick, data) {
  const bid = num(data && data.bid1);
  const ask = num(data && data.ask1);
  return `${tick}::${bid}::${ask}::` + levels.map(rowKey).join(";");
}

function tagsHtml(row) {
  const hangs = [];
  const fills = [];
  const cancels = [];
  for (const item of row.hangBuy) hangs.push(`<span class="tag hang buy">买挂 ${fmtQty(item.qty)}</span>`);
  for (const item of row.hangSell) hangs.push(`<span class="tag hang sell">卖挂 ${fmtQty(item.qty)}</span>`);
  for (const item of row.fillBuy) fills.push(`<span class="tag fill buy">买成 ${fmtQty(item.qty)}</span>`);
  for (const item of row.fillSell) fills.push(`<span class="tag fill sell">卖成 ${fmtQty(item.qty)}</span>`);
  if (row.cancelBuy) cancels.push(`<span class="tag cancel">买撤 ${fmtQty(row.cancelBuy)}</span>`);
  if (row.cancelSell) cancels.push(`<span class="tag cancel">卖撤 ${fmtQty(row.cancelSell)}</span>`);
  return { hangs: hangs.join(""), fills: fills.join(""), cancels: cancels.join("") };
}

function createRowEl(row) {
  const tags = tagsHtml(row);
  const el = document.createElement("div");
  el.className = `ladder-row${rowEmpty(row) ? " empty" : ""}`;
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
  const tags = tagsHtml(row);
  el.className = `ladder-row${rowEmpty(row) ? " empty" : ""}`;
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

function applyQuoteClasses(root, data, tick) {
  const bidIdx = num(data && data.bid1) > 0 ? String(priceToIdx(data.bid1, tick)) : "";
  const askIdx = num(data && data.ask1) > 0 ? String(priceToIdx(data.ask1, tick)) : "";
  for (const el of root.querySelectorAll(".ladder-row[data-idx]")) {
    el.classList.toggle("quote-bid", el.dataset.idx === bidIdx);
    el.classList.toggle("quote-ask", el.dataset.idx === askIdx);
  }
  const key = `${bidIdx}|${askIdx}`;
  if (key !== lastQuoteKey) {
    lastQuoteKey = key;
    const target = root.querySelector(".quote-bid, .quote-ask");
    if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function renderLadder(levels, tick, data) {
  const root = document.getElementById("ladder");
  const section = root.closest(".ladder-section");
  const scrollTop = section ? section.scrollTop : 0;
  const fingerprint = ladderFingerprint(levels, tick, data);

  if (!levels.length) {
    // 偶发空响应不立刻清空，避免整表闪没
    return;
  }

  if (fingerprint !== lastLadderKey) {
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
  }

  applyQuoteClasses(root, data, tick);
}

function parseEpochMs(ts) {
  if (ts == null || ts === "") return null;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === "string" && /^\d+(\.\d+)?$/.test(ts.trim())) {
    const n = Number(ts);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = new Date(ts);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function formatTs(ts) {
  const ms = parseEpochMs(ts);
  if (ms == null) return String(ts);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const zone =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName") || {};
  const suffix = zone.value ? ` ${zone.value}` : "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${suffix}`;
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
  return TICK;
}

function isUsableState(data) {
  if (!data || data.updatedAt == null || data.updatedAt === "") return false;
  const n =
    (data.openOrders || []).length +
    (data.orders || []).length +
    (data.deals || []).length;
  return n > 0 || num(data.bid1) > 0 || num(data.ask1) > 0;
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
      if (data.updatedAt != null) setLatestSync(data.updatedAt);
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
    renderLadder(buildLevels(data, tick), tick, data);
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
