const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN || "";
const MAX_LOGS = 5000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

let seq = 0;
const logs = [];
let state = {
  updatedAt: null,
  account: "",
  stock: "",
  openOrders: [],
  orders: [],
  deals: [],
  raw: null,
};

function unauthorized(res) {
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function checkToken(req, res, next) {
  if (!TOKEN) {
    return next();
  }
  const got = req.get("x-bridge-token") || req.query.token || "";
  if (got !== TOKEN) {
    return unauthorized(res);
  }
  return next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, updatedAt: state.updatedAt, logCount: logs.length });
});

app.post("/api/sync", checkToken, (req, res) => {
  const body = req.body || {};
  state = {
    updatedAt: new Date().toISOString(),
    account: body.account || "",
    stock: body.stock || "",
    openOrders: body.openOrders || [],
    orders: body.orders || [],
    deals: body.deals || [],
    raw: body,
  };
  res.json({
    ok: true,
    updatedAt: state.updatedAt,
    counts: {
      openOrders: state.openOrders.length,
      orders: state.orders.length,
      deals: state.deals.length,
    },
  });
});

app.get("/api/state", checkToken, (_req, res) => {
  res.json(state);
});

app.post("/api/debug", checkToken, (req, res) => {
  const body = req.body || {};
  const lines = Array.isArray(body.lines)
    ? body.lines
    : [{ level: body.level || "info", message: body.message || JSON.stringify(body) }];
  const accepted = [];
  for (const line of lines) {
    seq += 1;
    const item = {
      id: seq,
      ts: line.ts || new Date().toISOString(),
      level: line.level || "info",
      message: String(line.message == null ? "" : line.message),
    };
    logs.push(item);
    accepted.push(item);
  }
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
  res.json({ ok: true, accepted: accepted.length, lastId: seq });
});

app.get("/api/debug", checkToken, (req, res) => {
  const after = Number(req.query.after || 0);
  const tail = Number(req.query.tail || 0);
  let items = logs.filter((item) => item.id > after);
  if (tail > 0) {
    items = items.slice(-tail);
  }
  res.json({ ok: true, lastId: seq, items });
});

app.get("/api/commands", checkToken, (_req, res) => {
  res.json({ ok: true, commands: [] });
});

app.listen(PORT, () => {
  console.log(`qmt-bridge listening on ${PORT}`);
  if (!TOKEN) {
    console.log("BRIDGE_TOKEN is empty: API is open. Set it before exposing Azure publicly.");
  }
});
