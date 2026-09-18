const OPEN_STATUS = new Set([48, 49, 50, 51, 52, 55]);
const CANCEL_STATUS = new Set([53, 54, 57]);
const TICK = 0.001;
const LADDER_PAD = 15;
const QTY_KEY = "qmt_hang_qty";
const REQUEST_FADE_MS = 3000;
const HANG_BAR_IDLE_MS = 5000;
const HANG_BAR_FADE_MS = 3000;

let lastMetaText = "";
let lastSyncText = "";
let lastLadderKey = "";
let lastQuoteKey = "";
let lastGoodData = null;
let knownVersion = 0;
let emptyStreak = 0;
let refreshing = false;
let pendingHang = null;
let hangSubmitting = false;
let pendingCancel = null;
let cancelSubmitting = false;
let cancelBarTimer = null;
let cancelBarFadeTimer = null;
let hangBarTimer = null;
let hangBarFadeTimer = null;
let fadeCleanupTimer = null;
let lastPendingList = [];
const fadingHangs = new Map();

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

function pruneFadingHangs() {
  const now = Date.now();
  for (const [id, ghost] of fadingHangs) {
    if (now - ghost.started >= REQUEST_FADE_MS) fadingHangs.delete(id);
  }
}

function scheduleFadeCleanup() {
  if (fadeCleanupTimer) return;
  let wait = REQUEST_FADE_MS;
  const now = Date.now();
  for (const ghost of fadingHangs.values()) {
    wait = Math.min(wait, Math.max(0, REQUEST_FADE_MS - (now - ghost.started)));
  }
  fadeCleanupTimer = setTimeout(() => {
    fadeCleanupTimer = null;
    pruneFadingHangs();
    if (lastGoodData) {
      renderLadder(buildLevels(lastGoodData, tickValue()), tickValue(), lastGoodData);
    }
    if (fadingHangs.size) scheduleFadeCleanup();
  }, wait + 40);
}

function syncFadingHangs(list) {
  const next = Array.isArray(list) ? list : [];
  const nextIds = new Set(next.map((x) => String(x.id)));
  for (const old of lastPendingList) {
    const id = String(old.id);
    if (!nextIds.has(id) && !fadingHangs.has(id)) {
      fadingHangs.set(id, { ...old, started: Date.now() });
    }
  }
  for (const id of [...fadingHangs.keys()]) {
    if (nextIds.has(id)) fadingHangs.delete(id);
  }
  lastPendingList = next;
  pruneFadingHangs();
  if (fadingHangs.size) scheduleFadeCleanup();
}

function pendingHangsForLadder(data) {
  const live = data && Array.isArray(data.pendingHangs) ? data.pendingHangs : [];
  syncFadingHangs(live);
  const ghosts = [...fadingHangs.values()].map((g) => ({
    id: g.id,
    side: g.side,
    price: g.price,
    qty: g.qty,
    status: g.status || "pending",
    fading: true,
  }));
  return live.concat(ghosts);
}

function fmtQty(qty) {
  if (!qty) return "";
  return String(Math.round(qty));
}

function itemsKey(items) {
  return (items || [])
    .map((it) => `${it.side}:${it.request ? "r" : "l"}:${it.id}:${it.qty}:${it.status || ""}:${it.fading ? "f" : ""}:${it.cancelPending ? "c" : ""}`)
    .join(",");
}

function buildLevels(data, tick) {
  const hangs = { buy: new Map(), sell: new Map() };
  const fills = { buy: new Map(), sell: new Map() };
  const cancels = { buy: new Map(), sell: new Map() };
  const idxs = [];
  const canceling = new Set(
    (data.pendingCancels || [])
      .map((x) => String(x.targetOrderId || x.target_order_id || ""))
      .filter(Boolean)
  );

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
      pushItem(
        hangs[side],
        orderPrice(row),
        { qty: remaining, id: orderId, side, cancelPending: canceling.has(String(orderId)) },
        false
      );
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

  for (const row of pendingHangsForLadder(data)) {
    const side = row.side === "sell" ? "sell" : "buy";
    pushItem(
      hangs[side],
      num(row.price),
      {
        qty: num(row.qty),
        id: `req-${row.id}`,
        side,
        request: true,
        status: row.status || "pending",
        fading: Boolean(row.fading),
      },
      false
    );
  }

  if (num(data.bid1) > 0) idxs.push(priceToIdx(data.bid1, tick));
  if (num(data.ask1) > 0) idxs.push(priceToIdx(data.ask1, tick));

  if (!idxs.length) return [];

  let min = Math.min(...idxs);
  let max = Math.max(...idxs);
  if (num(data.bid1) > 0) {
    const bidIdx = priceToIdx(data.bid1, tick);
    min = Math.min(min, bidIdx - LADDER_PAD);
  }
  if (num(data.ask1) > 0) {
    const askIdx = priceToIdx(data.ask1, tick);
    max = Math.max(max, askIdx + LADDER_PAD);
  }
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

function hangTagHtml(item) {
  const sell = item.side === "sell";
  const label = sell ? "卖挂" : "买挂";
  if (item.request) {
    const st = item.status === "claimed" ? "执行中" : "待执行";
    const fade = item.fading ? " fade-out" : "";
    return `<span class="tag hang ${sell ? "sell" : "buy"} request${fade}">${label} ${fmtQty(item.qty)} ${st}</span>`;
  }
  const extra = item.cancelPending ? " canceling" : " live";
  const suffix = item.cancelPending ? " 撤单中" : "";
  const oid = String(item.id || "").replace(/"/g, "");
  return `<span class="tag hang ${sell ? "sell" : "buy"}${extra}" data-order-id="${oid}" data-side="${sell ? "sell" : "buy"}" data-qty="${num(item.qty)}">${label} ${fmtQty(item.qty)}${suffix}</span>`;
}

function tagsHtml(row) {
  const hangs = [];
  const fills = [];
  const cancels = [];
  for (const item of row.hangBuy) hangs.push(hangTagHtml(item));
  for (const item of row.hangSell) hangs.push(hangTagHtml(item));
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
  const bid = num(data && data.bid1);
  const ask = num(data && data.ask1);
  const bidIdx = bid > 0 ? priceToIdx(bid, tick) : null;
  const askIdx = ask > 0 ? priceToIdx(ask, tick) : null;
  for (const el of root.querySelectorAll(".ladder-row[data-idx]")) {
    const idx = Number(el.dataset.idx);
    el.classList.toggle("quote-bid", bidIdx != null && idx === bidIdx);
    el.classList.toggle("quote-ask", askIdx != null && idx === askIdx);
    const canBuy = bidIdx != null && idx < bidIdx;
    const canSell = askIdx != null && idx > askIdx;
    el.classList.toggle("can-buy", canBuy);
    el.classList.toggle("can-sell", canSell);
    el.classList.toggle("no-hang", !canBuy && !canSell);
  }
  const key = `${bidIdx}|${askIdx}`;
  lastQuoteKey = key;
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

function hangQty() {
  const el = document.getElementById("hang-qty");
  const n = Math.round(Number(el && el.value));
  return n > 0 ? n : 10000;
}

function loadHangQty() {
  const el = document.getElementById("hang-qty");
  if (!el) return;
  const saved = Number(localStorage.getItem(QTY_KEY));
  if (Number.isFinite(saved) && saved >= 100) el.value = String(saved);
  el.addEventListener("change", () => {
    const n = hangQty();
    el.value = String(n);
    localStorage.setItem(QTY_KEY, String(n));
  });
}

function hideHangBar(opts) {
  const fade = Boolean(opts && opts.fade);
  if (hangBarTimer) {
    clearTimeout(hangBarTimer);
    hangBarTimer = null;
  }
  if (hangBarFadeTimer) {
    clearTimeout(hangBarFadeTimer);
    hangBarFadeTimer = null;
  }
  const bar = document.getElementById("hang-bar");
  if (!bar) {
    pendingHang = null;
    return;
  }
  if (!fade || bar.classList.contains("hidden")) {
    pendingHang = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
    return;
  }
  bar.classList.add("fade-out");
  hangBarFadeTimer = setTimeout(() => {
    hangBarFadeTimer = null;
    pendingHang = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
  }, HANG_BAR_FADE_MS);
}

function ensureHangBar() {
  let bar = document.getElementById("hang-bar");
  if (bar && bar.parentNode === document.body) {
    wireHangBarButtons();
    return bar;
  }
  if (bar && bar.parentNode !== document.body) {
    bar.remove();
  }
  bar = document.createElement("div");
  bar.id = "hang-bar";
  bar.className = "hang-bar hidden";
  bar.innerHTML = `
    <span id="hang-bar-text"></span>
    <button type="button" id="hang-confirm" class="hang-btn confirm">确认</button>
    <button type="button" id="hang-cancel" class="hang-btn cancel">取消</button>`;
  document.body.appendChild(bar);
  wireHangBarButtons();
  return bar;
}

function wireHangBarButtons() {
  const confirmBtn = document.getElementById("hang-confirm");
  const cancelBtn = document.getElementById("hang-cancel");
  if (confirmBtn && !confirmBtn.dataset.wired) {
    confirmBtn.dataset.wired = "1";
    confirmBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      submitHang().catch(() => {});
    });
  }
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = "1";
    cancelBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hideHangBar();
    });
  }
}

function placeHangBar(bar, clientX, clientY) {
  bar.style.left = "0px";
  bar.style.top = "0px";
  const w = bar.offsetWidth || 220;
  const h = bar.offsetHeight || 40;
  const pad = 8;
  let left = clientX + 12;
  let top = clientY - Math.round(h / 2);
  if (left + w + pad > window.innerWidth) left = clientX - w - 12;
  if (left < pad) left = pad;
  if (top + h + pad > window.innerHeight) top = window.innerHeight - h - pad;
  if (top < pad) top = pad;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function showHangBar(side, price, point) {
  hideCancelBar();
  pendingHang = { side, price };
  const bar = ensureHangBar();
  const text = document.getElementById("hang-bar-text");
  if (!bar || !text) {
    setMeta("确认栏加载失败，请强制刷新页面");
    return;
  }
  const label = side === "buy" ? "买挂" : "卖挂";
  text.textContent = `${label} ${price.toFixed(3)} × ${hangQty()}`;
  if (hangBarFadeTimer) {
    clearTimeout(hangBarFadeTimer);
    hangBarFadeTimer = null;
  }
  bar.classList.remove("hidden", "fade-out");
  bar.classList.toggle("buy", side === "buy");
  bar.classList.toggle("sell", side === "sell");
  const x = point && Number.isFinite(point.x) ? point.x : window.innerWidth / 2;
  const y = point && Number.isFinite(point.y) ? point.y : window.innerHeight / 2;
  placeHangBar(bar, x, y);
  if (hangBarTimer) clearTimeout(hangBarTimer);
  hangBarTimer = setTimeout(() => {
    hangBarTimer = null;
    hideHangBar({ fade: true });
  }, HANG_BAR_IDLE_MS);
}

function hideCancelBar(opts) {
  const fade = Boolean(opts && opts.fade);
  if (cancelBarTimer) {
    clearTimeout(cancelBarTimer);
    cancelBarTimer = null;
  }
  if (cancelBarFadeTimer) {
    clearTimeout(cancelBarFadeTimer);
    cancelBarFadeTimer = null;
  }
  const bar = document.getElementById("cancel-bar");
  if (!bar) {
    pendingCancel = null;
    return;
  }
  if (!fade || bar.classList.contains("hidden")) {
    pendingCancel = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
    return;
  }
  bar.classList.add("fade-out");
  cancelBarFadeTimer = setTimeout(() => {
    cancelBarFadeTimer = null;
    pendingCancel = null;
    bar.classList.remove("fade-out");
    bar.classList.add("hidden");
  }, HANG_BAR_FADE_MS);
}

function ensureCancelBar() {
  let bar = document.getElementById("cancel-bar");
  if (bar && bar.parentNode === document.body) {
    wireCancelBarButtons();
    return bar;
  }
  if (bar && bar.parentNode !== document.body) {
    bar.remove();
  }
  bar = document.createElement("div");
  bar.id = "cancel-bar";
  bar.className = "hang-bar hidden";
  bar.innerHTML = `
    <span id="cancel-bar-text"></span>
    <button type="button" id="cancel-confirm" class="hang-btn confirm">确认</button>
    <button type="button" id="cancel-dismiss" class="hang-btn cancel">取消</button>`;
  document.body.appendChild(bar);
  wireCancelBarButtons();
  return bar;
}

function wireCancelBarButtons() {
  const confirmBtn = document.getElementById("cancel-confirm");
  const dismissBtn = document.getElementById("cancel-dismiss");
  if (confirmBtn && !confirmBtn.dataset.wired) {
    confirmBtn.dataset.wired = "1";
    confirmBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      submitCancel().catch(() => {});
    });
  }
  if (dismissBtn && !dismissBtn.dataset.wired) {
    dismissBtn.dataset.wired = "1";
    dismissBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hideCancelBar();
    });
  }
}

function showCancelBar(info, point) {
  hideHangBar();
  pendingCancel = info;
  const bar = ensureCancelBar();
  const text = document.getElementById("cancel-bar-text");
  if (!bar || !text) return;
  const label = info.side === "sell" ? "卖挂" : "买挂";
  text.textContent = `撤 ${label} ${Number(info.price).toFixed(3)} × ${info.qty}`;
  if (cancelBarFadeTimer) {
    clearTimeout(cancelBarFadeTimer);
    cancelBarFadeTimer = null;
  }
  bar.classList.remove("hidden", "fade-out");
  bar.classList.toggle("buy", info.side === "buy");
  bar.classList.toggle("sell", info.side === "sell");
  const x = point && Number.isFinite(point.x) ? point.x : window.innerWidth / 2;
  const y = point && Number.isFinite(point.y) ? point.y : window.innerHeight / 2;
  placeHangBar(bar, x, y);
  if (cancelBarTimer) clearTimeout(cancelBarTimer);
  cancelBarTimer = setTimeout(() => {
    cancelBarTimer = null;
    hideCancelBar({ fade: true });
  }, HANG_BAR_IDLE_MS);
}

function onHangTagClick(tag, point) {
  if (!lastGoodData || cancelSubmitting) return;
  if (tag.classList.contains("request")) return;
  const orderId = String(tag.dataset.orderId || "");
  if (!orderId) return;
  if (tag.classList.contains("canceling")) {
    setMeta("该挂单已有撤单请求");
    return;
  }
  const row = tag.closest(".ladder-row[data-idx]");
  const idx = Number(row && row.dataset.idx);
  const price = Number.isFinite(idx) ? idxToPrice(idx, TICK) : 0;
  showCancelBar(
    {
      orderId,
      side: tag.dataset.side === "sell" ? "sell" : "buy",
      qty: num(tag.dataset.qty),
      price,
    },
    point
  );
}

async function submitCancel() {
  if (!pendingCancel || !lastGoodData || cancelSubmitting) return;
  const info = pendingCancel;
  cancelSubmitting = true;
  try {
    const res = await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetOrderId: info.orderId,
        side: info.side,
        price: info.price,
        qty: info.qty,
        stock: lastGoodData.stock,
        account: lastGoodData.account,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    setMeta(`撤单请求已写入 #${data.order.id}（待策略执行）`);
    hideCancelBar();
    const next = {
      id: data.order.id,
      targetOrderId: String(data.order.target_order_id || info.orderId),
      side: info.side,
      price: info.price,
      qty: info.qty,
      status: data.order.status || "pending",
      action: "cancel",
    };
    const prev = lastGoodData.pendingCancels || [];
    if (!prev.some((x) => String(x.targetOrderId || x.target_order_id) === String(next.targetOrderId))) {
      lastGoodData.pendingCancels = prev.concat(next);
    }
    renderLadder(buildLevels(lastGoodData, tickValue()), tickValue(), lastGoodData);
  } catch (err) {
    setMeta(`撤单失败: ${err.message}`);
  } finally {
    cancelSubmitting = false;
  }
}

function onPriceClick(el, point) {
  hideCancelBar();
  if (!lastGoodData || hangSubmitting) return;
  const idx = Number(el.dataset.idx);
  if (!Number.isFinite(idx)) return;
  const price = idxToPrice(idx, TICK);
  const bid = num(lastGoodData.bid1);
  const ask = num(lastGoodData.ask1);
  const bidIdx = bid > 0 ? priceToIdx(bid, TICK) : null;
  const askIdx = ask > 0 ? priceToIdx(ask, TICK) : null;
  if (bidIdx != null && idx < bidIdx) {
    showHangBar("buy", price, point);
    return;
  }
  if (askIdx != null && idx > askIdx) {
    showHangBar("sell", price, point);
    return;
  }
  hideHangBar();
  setMeta("买挂仅限买1下方，卖挂仅限卖1上方");
}

async function submitHang() {
  if (!pendingHang || !lastGoodData || hangSubmitting) return;
  const { side, price } = pendingHang;
  const qty = hangQty();
  hangSubmitting = true;
  try {
    const res = await fetch("/api/hang", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        side,
        price,
        qty,
        stock: lastGoodData.stock,
        account: lastGoodData.account,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const label = side === "buy" ? "买挂" : "卖挂";
    setMeta(`${label}请求已写入 #${data.order.id}：${price.toFixed(3)} × ${qty}（待策略执行）`);
    hideHangBar();
    if (lastGoodData) {
      const next = {
        id: data.order.id,
        account: data.order.account,
        stock: data.order.stock,
        side: data.order.side,
        price: Number(data.order.price),
        qty: Number(data.order.qty),
        status: data.order.status || "pending",
      };
      const prev = lastGoodData.pendingHangs || [];
      if (!prev.some((x) => Number(x.id) === Number(next.id))) {
        lastGoodData.pendingHangs = prev.concat(next);
      }
      renderLadder(buildLevels(lastGoodData, tickValue()), tickValue(), lastGoodData);
    }
  } catch (err) {
    setMeta(`挂单失败: ${err.message}`);
  } finally {
    hangSubmitting = false;
  }
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
      if (lastGoodData && (Array.isArray(data.pendingHangs) || Array.isArray(data.pendingCancels))) {
        if (Array.isArray(data.pendingHangs)) lastGoodData.pendingHangs = data.pendingHangs;
        if (Array.isArray(data.pendingCancels)) lastGoodData.pendingCancels = data.pendingCancels;
        renderLadder(buildLevels(lastGoodData, tick), tick, lastGoodData);
      }
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
}, 3000);

loadHangQty();
ensureHangBar();
wireHangBarButtons();
ensureCancelBar();
wireCancelBarButtons();

document.getElementById("ladder").addEventListener("click", (ev) => {
  const hangTag = ev.target.closest(".tag.hang.live, .tag.hang.canceling");
  if (hangTag) {
    ev.stopPropagation();
    onHangTagClick(hangTag, { x: ev.clientX, y: ev.clientY });
    return;
  }
  const priceEl = ev.target.closest(".price");
  if (!priceEl) return;
  const row = priceEl.closest(".ladder-row[data-idx]");
  if (!row) return;
  onPriceClick(row, { x: ev.clientX, y: ev.clientY });
});

(async function gateConsole() {
  try {
    const res = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401) {
      location.replace("/login.html");
      return;
    }
    const data = await res.json();
    const btn = document.getElementById("logout-btn");
    if (btn && data.auth) {
      btn.hidden = false;
      btn.addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
        location.replace("/login.html");
      });
    }
  } catch (_err) {
    /* ignore */
  }
})();

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
