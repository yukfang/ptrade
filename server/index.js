const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN || "";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    res.json(await db.health());
  })
);

app.post(
  "/api/sync",
  checkToken,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const saved = await db.saveSnapshot(body);
    const iso = saved.updatedAt instanceof Date ? saved.updatedAt.toISOString() : saved.updatedAt;
    res.json({
      ok: true,
      updatedAt: iso,
      version: saved.version,
      unchanged: saved.unchanged,
      counts: {
        openOrders: (body.openOrders || []).length,
        orders: (body.orders || []).length,
        deals: (body.deals || []).length,
      },
    });
  })
);

app.get(
  "/api/state",
  checkToken,
  asyncHandler(async (req, res) => {
    res.json(await db.getSnapshot(Number(req.query.since || 0)));
  })
);

app.post(
  "/api/debug",
  checkToken,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const lines = Array.isArray(body.lines)
      ? body.lines
      : [{ level: body.level || "info", message: body.message || JSON.stringify(body) }];
    const result = await db.appendDebug(lines);
    res.json({ ok: true, ...result });
  })
);

app.get(
  "/api/debug",
  checkToken,
  asyncHandler(async (req, res) => {
    const after = Number(req.query.after || 0);
    const tail = Number(req.query.tail || 0);
    const result = await db.getDebug({ after, tail });
    res.json({ ok: true, ...result });
  })
);

app.get("/api/commands", checkToken, (_req, res) => {
  res.json({ ok: true, commands: [] });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || "server error" });
});

async function main() {
  await db.ensureSchema();
  app.listen(PORT, () => {
    console.log(`qmt-bridge listening on ${PORT}, mysql ${process.env.MYSQL_HOST}/${process.env.MYSQL_DATABASE}`);
    if (!TOKEN) {
      console.log("BRIDGE_TOKEN is empty: API is open.");
    }
  });
}

main().catch((err) => {
  console.error("failed to start:", err);
  process.exit(1);
});
