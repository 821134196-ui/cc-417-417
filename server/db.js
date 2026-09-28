'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, DB_PATH } = require('./config');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 终端
CREATE TABLE IF NOT EXISTS terminals (
  id              TEXT PRIMARY KEY,           -- T-001
  name            TEXT NOT NULL,
  location        TEXT NOT NULL,
  x               REAL NOT NULL,              -- 地图坐标 0-100
  y               REAL NOT NULL,
  online          INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,  -- 故障停用：断纸/卡纸/号段用尽
  paper_remaining INTEGER NOT NULL,            -- 当前纸卷剩余张数
  paper_capacity  INTEGER NOT NULL,            -- 满卷张数
  roll_id         TEXT,                        -- 当前纸卷批次
  last_refill_at  TEXT,
  created_at      TEXT NOT NULL
);

-- 纸卷批次（库存：in_stock / installed / used）
CREATE TABLE IF NOT EXISTS paper_rolls (
  id             TEXT PRIMARY KEY,            -- R-2026-0001
  batch_no       TEXT NOT NULL UNIQUE,
  capacity       INTEGER NOT NULL,            -- 额定张数
  status         TEXT NOT NULL DEFAULT 'in_stock',
  terminal_id    TEXT REFERENCES terminals(id),
  installed_at   TEXT,
  used_up_at     TEXT,
  created_at     TEXT NOT NULL
);

-- 票据号段（每个终端一个 active 段，用完 closed，绝不跳号）
CREATE TABLE IF NOT EXISTS ticket_ranges (
  id          TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  prefix      TEXT NOT NULL,                  -- 号段前缀，如 A
  start_no    INTEGER NOT NULL,
  end_no      INTEGER NOT NULL,
  next_no     INTEGER NOT NULL,               -- 下一张可发票号
  status      TEXT NOT NULL DEFAULT 'active', -- active / closed_exhausted
  created_at  TEXT NOT NULL,
  closed_at   TEXT
);

-- 已打印票据（号段连续性台账）
CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  range_id    TEXT NOT NULL REFERENCES ticket_ranges(id),
  ticket_no   INTEGER NOT NULL,
  ticket_code TEXT NOT NULL UNIQUE,           -- A-000123
  order_id    TEXT,                           -- 出票时关联订单
  issue_type  TEXT NOT NULL,                  -- sale / manual_reissue / duplicate / demo
  status      TEXT NOT NULL DEFAULT 'printed',-- printed / void_jam / void_nopaper / duplicate
  issued_at   TEXT NOT NULL,
  UNIQUE(terminal_id, ticket_no)
);

-- 收款订单（幂等键 client_request_id）
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  terminal_id        TEXT NOT NULL REFERENCES terminals(id),
  client_request_id  TEXT NOT NULL UNIQUE,
  item               TEXT NOT NULL,
  amount             INTEGER NOT NULL,        -- 分
  status             TEXT NOT NULL,           -- created/paid/issued/ticket_failed/refunded/closed
  pay_ref            TEXT,
  paid_at            TEXT,
  ticket_id          TEXT REFERENCES tickets(id),
  fail_reason        TEXT,                    -- no_paper / jam / range_exhausted / offline
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_terminal ON orders(terminal_id);

-- 支付流水（模拟支付适配器）
CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  ref         TEXT NOT NULL UNIQUE,
  amount      INTEGER NOT NULL,
  status      TEXT NOT NULL,                  -- success / failed
  idemp_key   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- 故障工单
CREATE TABLE IF NOT EXISTS fault_tickets (
  id           TEXT PRIMARY KEY,
  terminal_id  TEXT NOT NULL REFERENCES terminals(id),
  kind         TEXT NOT NULL,                 -- no_paper / paper_jam / range_exhausted / roll_reversed / offline / paid_no_ticket / duplicate_ticket
  severity     TEXT NOT NULL DEFAULT 'normal',-- normal / high
  status       TEXT NOT NULL DEFAULT 'open',  -- open / in_repair / resolved / rejected
  summary      TEXT NOT NULL,
  order_id     TEXT REFERENCES orders(id),
  assignee     TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS idx_faults_status ON fault_tickets(status);

-- 复核队列（扣款成功未出票 / 重复出票 / 退款超时 / 纸卷倒装 / 设备离线）
CREATE TABLE IF NOT EXISTS review_queue (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,                  -- paid_no_ticket / duplicate_ticket / refund_timeout / roll_reversed / offline
  terminal_id TEXT REFERENCES terminals(id),
  order_id    TEXT REFERENCES orders(id),
  fault_id    TEXT REFERENCES fault_tickets(id),
  status      TEXT NOT NULL DEFAULT 'pending',-- pending / approved_refund / manual_ticket / dismissed / locked
  note        TEXT,
  created_at  TEXT NOT NULL,
  handled_at  TEXT,
  handler     TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status, category);

-- 退款（每原订单至多一条成功退款）
CREATE TABLE IF NOT EXISTS refunds (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE REFERENCES orders(id),
  amount        INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL,                -- requested / approved / rejected / timeout / success
  evidence      TEXT,                         -- JSON 证据链快照
  reviewer      TEXT,
  source        TEXT NOT NULL DEFAULT 'manual', -- manual / auto_queue
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

-- 补给路线与任务
CREATE TABLE IF NOT EXISTS refill_routes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refill_tasks (
  id            TEXT PRIMARY KEY,
  route_id      TEXT REFERENCES refill_routes(id),
  terminal_id   TEXT NOT NULL REFERENCES terminals(id),
  seq           INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued/claimed/enroute/cabinet_open/done/skipped
  locked_by     TEXT,                          -- 任务锁定者（两名补给员同时领取只保留一个）
  locked_at     TEXT,
  scan_code     TEXT,                          -- 柜门锁扫码口令
  scanned_at    TEXT,
  before_photo  TEXT,                          -- 换卷前计数器照片（文件路径）
  after_photo   TEXT,                          -- 换卷后计数器照片
  roll_id       TEXT REFERENCES paper_rolls(id),
  before_count  INTEGER,
  after_count   INTEGER,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(route_id, terminal_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON refill_tasks(status);

-- 设备回执文件登记（本地文件保存）
CREATE TABLE IF NOT EXISTS device_receipts (
  id          TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES terminals(id),
  kind        TEXT NOT NULL,                  -- counter_before / counter_after / cabinet / print / offline_sync
  file_path   TEXT NOT NULL,
  ref_type    TEXT,                           -- order / task / ticket
  ref_id      TEXT,
  created_at  TEXT NOT NULL
);

-- 离线补传事件（去重：client_event_id UNIQUE）
CREATE TABLE IF NOT EXISTS offline_events (
  id              TEXT PRIMARY KEY,
  terminal_id     TEXT NOT NULL REFERENCES terminals(id),
  client_event_id TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,              -- ticket_printed / counter / heartbeat
  payload         TEXT NOT NULL,              -- JSON
  event_time      TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  applied         INTEGER NOT NULL DEFAULT 0
);
`;

function openDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// 内存库（测试用）
function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// 轻量列迁移（幂等）
const COLUMN_MIGRATIONS = [
  ['tickets', 'status', "ALTER TABLE tickets ADD COLUMN status TEXT NOT NULL DEFAULT 'printed'"]
];
function migrate(db) {
  for (const [table, col, ddl] of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.length && !cols.some((c) => c.name === col)) db.exec(ddl);
  }
}

module.exports = { openDb, openMemory, SCHEMA };
