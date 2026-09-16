const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

let pool;

const DEFAULT_CA = path.join(__dirname, "..", "assets", "ApsaraDB-CA-Chain", "ApsaraDB-CA-Chain.pem");

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
  const flag = String(urlSsl || process.env.MYSQL_SSL || "true").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "disable") {
    return undefined;
  }
  const caPath = path.isAbsolute(process.env.MYSQL_SSL_CA || "")
    ? process.env.MYSQL_SSL_CA
    : process.env.MYSQL_SSL_CA
      ? path.join(__dirname, "..", process.env.MYSQL_SSL_CA)
      : DEFAULT_CA;
  if (!fs.existsSync(caPath)) {
    throw new Error("MySQL SSL CA not found: " + caPath);
  }
  return {
    ca: fs.readFileSync(caPath),
    rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== "false",
    minVersion: "TLSv1.2",
  };
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
      content_hash VARCHAR(40) NOT NULL DEFAULT '',
      version BIGINT NOT NULL DEFAULT 0,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_account_stock (account, stock)
    )
  `);
  await ensureColumn("sync_snapshot", "content_hash", "VARCHAR(40) NOT NULL DEFAULT ''");
  await ensureColumn("sync_snapshot", "version", "BIGINT NOT NULL DEFAULT 0");
  await backfillSnapshotVersions();
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

async function ensureColumn(table, column, def) {
  const db = getPool();
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  if (!rows.length) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
  }
}

function hashPayload(json) {
  const crypto = require("crypto");
  return crypto.createHash("sha1").update(json).digest("hex");
}

async function backfillSnapshotVersions() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, payload, version, content_hash
     FROM sync_snapshot
     WHERE version = 0 OR content_hash = '' OR content_hash IS NULL`
  );
  for (const row of rows) {
    const json = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
    const hash = row.content_hash || hashPayload(json);
    await db.query(
      `UPDATE sync_snapshot
       SET version = GREATEST(COALESCE(version, 0), 1), content_hash = ?
       WHERE id = ?`,
      [hash, row.id]
    );
  }
}

async function saveSnapshot(payload) {
  const account = String(payload.account || "");
  const stock = String(payload.stock || "");
  const json = JSON.stringify(payload);
  const hash = hashPayload(json);
  const db = getPool();
  const [cur] = await db.query(
    `SELECT version, content_hash FROM sync_snapshot WHERE account = ? AND stock = ?`,
    [account, stock]
  );
  const prev = cur[0];
  const prevVersion = prev ? Number(prev.version) || 0 : 0;
  const same = Boolean(prev && prev.content_hash && prev.content_hash === hash && prevVersion > 0);
  const nextVersion = same ? prevVersion : Math.max(1, prevVersion + 1);

  await db.query(
    `INSERT INTO sync_snapshot (account, stock, payload, content_hash, version, updated_at)
     VALUES (?, ?, CAST(? AS JSON), ?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       payload = IF(content_hash = VALUES(content_hash), payload, VALUES(payload)),
       version = VALUES(version),
       updated_at = IF(content_hash = VALUES(content_hash), updated_at, VALUES(updated_at)),
       content_hash = VALUES(content_hash)`,
    [account, stock, json, hash, nextVersion]
  );
  const [rows] = await db.query(
    `SELECT updated_at, version FROM sync_snapshot WHERE account = ? AND stock = ?`,
    [account, stock]
  );
  return {
    updatedAt: rows[0] ? rows[0].updated_at : new Date(),
    version: rows[0] ? Number(rows[0].version) || nextVersion : nextVersion,
    unchanged: Boolean(same),
  };
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

function emptySnapshot() {
  return {
    unchanged: false,
    version: 0,
    updatedAt: null,
    account: "",
    stock: "",
    openOrders: [],
    orders: [],
    deals: [],
  };
}

async function getSnapshot(since = 0) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT account, stock, payload, updated_at, version
     FROM sync_snapshot
     ORDER BY version DESC, updated_at DESC
     LIMIT 1`
  );
  if (!rows.length) {
    return emptySnapshot();
  }
  const row = rows[0];
  const version = Number(row.version) || 0;
  if (since > 0 && version > 0 && since >= version) {
    return { unchanged: true, version };
  }
  const payload = parsePayload(row.payload) || {};
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  return {
    unchanged: false,
    version,
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
  return { ok: true, db: true, updatedAt: snapshot.updatedAt, version: snapshot.version || 0, logCount: lastId };
}

module.exports = {
  ensureSchema,
  saveSnapshot,
  getSnapshot,
  appendDebug,
  getDebug,
  health,
};
