const mysql = require("mysql2/promise");

let pool;

function stripQuotes(value) {
  const s = String(value || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseMysqlUrl(raw) {
  const s = stripQuotes(raw);
  if (!s.startsWith("mysql://")) {
    throw new Error("PTRADE_DATABASE_URL must start with mysql://");
  }
  const rest = s.slice("mysql://".length);
  const at = rest.lastIndexOf("@");
  if (at < 0) {
    throw new Error("PTRADE_DATABASE_URL missing host");
  }
  const userinfo = rest.slice(0, at);
  const hostpart = rest.slice(at + 1);
  const colon = userinfo.indexOf(":");
  const user = decodeURIComponent(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
  const password = decodeURIComponent(colon >= 0 ? userinfo.slice(colon + 1) : "");
  const [hostportpath, query] = hostpart.split("?");
  const slash = hostportpath.indexOf("/");
  const hostport = slash >= 0 ? hostportpath.slice(0, slash) : hostportpath;
  const database = decodeURIComponent(slash >= 0 ? hostportpath.slice(slash + 1) : "");
  const [host, port] = hostport.split(":");
  const params = new URLSearchParams(query || "");
  return {
    host,
    port: Number(port || 3306),
    user,
    password,
    database,
    ssl: String(params.get("ssl") || "").toLowerCase(),
  };
}

function sslOption(urlSsl) {
  const flag = String(urlSsl || process.env.MYSQL_SSL || "").toLowerCase();
  if (flag === "1" || flag === "true" || flag === "required") {
    return { rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== "false" };
  }
  return undefined;
}

function connectionConfig() {
  if (process.env.PTRADE_DATABASE_URL) {
    const parsed = parseMysqlUrl(process.env.PTRADE_DATABASE_URL);
    if (!parsed.host || !parsed.user || !parsed.database) {
      throw new Error("PTRADE_DATABASE_URL is incomplete");
    }
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      ssl: sslOption(parsed.ssl),
    };
  }
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  if (!host || !user || !database) {
    throw new Error("Set PTRADE_DATABASE_URL or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE");
  }
  return {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    ssl: sslOption(),
  };
}

function getPool() {
  if (pool) {
    return pool;
  }
  const cfg = connectionConfig();
  pool = mysql.createPool({
    ...cfg,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
  });
  return pool;
}

async function ensureSchema() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_snapshot (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      account VARCHAR(64) NOT NULL DEFAULT '',
      stock VARCHAR(32) NOT NULL DEFAULT '',
      payload JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_account_stock (account, stock)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS debug_log (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      ts VARCHAR(40) NOT NULL,
      level VARCHAR(16) NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_id (id)
    )
  `);
}

async function saveSnapshot(payload) {
  const account = String(payload.account || "");
  const stock = String(payload.stock || "");
  const json = JSON.stringify(payload);
  const db = getPool();
  await db.query(
    `INSERT INTO sync_snapshot (account, stock, payload, updated_at)
     VALUES (?, ?, CAST(? AS JSON), CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       payload = VALUES(payload),
       updated_at = VALUES(updated_at)`,
    [account, stock, json]
  );
  const [rows] = await db.query(
    `SELECT updated_at FROM sync_snapshot WHERE account = ? AND stock = ?`,
    [account, stock]
  );
  return rows[0] ? rows[0].updated_at : new Date();
}

function parsePayload(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  return JSON.parse(value);
}

async function getSnapshot() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT account, stock, payload, updated_at
     FROM sync_snapshot
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  if (!rows.length) {
    return {
      updatedAt: null,
      account: "",
      stock: "",
      openOrders: [],
      orders: [],
      deals: [],
    };
  }
  const row = rows[0];
  const payload = parsePayload(row.payload) || {};
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  return {
    ...payload,
    updatedAt,
    account: payload.account || row.account,
    stock: payload.stock || row.stock,
    openOrders: payload.openOrders || [],
    orders: payload.orders || [],
    deals: payload.deals || [],
  };
}

async function appendDebug(lines) {
  if (!lines.length) {
    return { accepted: 0, lastId: await maxDebugId() };
  }
  const db = getPool();
  const values = lines.map((line) => [
    line.ts || new Date().toISOString(),
    line.level || "info",
    String(line.message == null ? "" : line.message),
  ]);
  await db.query(`INSERT INTO debug_log (ts, level, message) VALUES ?`, [values]);
  return { accepted: lines.length, lastId: await maxDebugId() };
}

async function maxDebugId() {
  const db = getPool();
  const [rows] = await db.query(`SELECT MAX(id) AS lastId FROM debug_log`);
  return Number(rows[0] && rows[0].lastId) || 0;
}

async function getDebug({ after = 0, tail = 0 } = {}) {
  const db = getPool();
  const lastId = await maxDebugId();
  let sql = `SELECT id, ts, level, message FROM debug_log WHERE id > ? ORDER BY id ASC`;
  const params = [after];
  if (tail > 0) {
    sql = `SELECT id, ts, level, message FROM (
             SELECT id, ts, level, message FROM debug_log WHERE id > ? ORDER BY id DESC LIMIT ?
           ) t ORDER BY id ASC`;
    params.push(tail);
  }
  const [rows] = await db.query(sql, params);
  return { lastId, items: rows };
}

async function health() {
  const db = getPool();
  await db.query("SELECT 1");
  const snapshot = await getSnapshot();
  const lastId = await maxDebugId();
  return { ok: true, db: true, updatedAt: snapshot.updatedAt, logCount: lastId };
}

module.exports = {
  ensureSchema,
  saveSnapshot,
  getSnapshot,
  appendDebug,
  getDebug,
  health,
};
