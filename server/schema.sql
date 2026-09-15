-- 第一版两张表；应用启动时也会 CREATE IF NOT EXISTS。
-- payload 存 QMT 推过来的完整 JSON，字段稳定后再拆列。

CREATE TABLE IF NOT EXISTS sync_snapshot (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  account VARCHAR(64) NOT NULL DEFAULT '',
  stock VARCHAR(32) NOT NULL DEFAULT '',
  payload JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_account_stock (account, stock)
);

CREATE TABLE IF NOT EXISTS debug_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ts VARCHAR(40) NOT NULL,
  level VARCHAR(16) NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_id (id)
);
