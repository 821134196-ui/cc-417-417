"""SQLite 连接与建表脚本。"""
import json
import os
import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS terminals (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    location            TEXT NOT NULL,
    map_x               REAL NOT NULL,
    map_y               REAL NOT NULL,
    online              INTEGER NOT NULL DEFAULT 1,
    paper_remaining     INTEGER NOT NULL DEFAULT 0,      -- 剩余可打票数
    paper_capacity      INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'normal',  -- normal/no_paper/jam/offline
    current_batch_id    TEXT,
    seg_start           INTEGER,
    seg_end             INTEGER,
    seg_next            INTEGER,
    last_replenished_at TEXT,
    last_heartbeat      TEXT
);

CREATE TABLE IF NOT EXISTS paper_roll_batches (
    id                 TEXT PRIMARY KEY,
    supplier           TEXT NOT NULL,
    ticket_count       INTEGER NOT NULL,             -- 整卷票面容量(张)
    remaining_count    INTEGER NOT NULL,
    segment_start      INTEGER,
    segment_end        INTEGER,
    status             TEXT NOT NULL DEFAULT 'in_stock', -- in_stock/installed/used_up
    installed_terminal TEXT,
    reversed           INTEGER NOT NULL DEFAULT 0,   -- 演示:倒装纸卷
    received_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    terminal_id TEXT NOT NULL,
    batch_id    TEXT NOT NULL,
    start_no    INTEGER NOT NULL,
    end_no      INTEGER NOT NULL,
    next_no     INTEGER NOT NULL,                -- 下一张待开票号
    status      TEXT NOT NULL DEFAULT 'active',  -- active/exhausted/retired
    mounted_at  TEXT NOT NULL,
    retired_at  TEXT,
    FOREIGN KEY (terminal_id) REFERENCES terminals(id)
);

CREATE TABLE IF NOT EXISTS payment_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no    TEXT NOT NULL UNIQUE,
    idem_key    TEXT NOT NULL UNIQUE,            -- 客户端幂等键
    terminal_id TEXT NOT NULL,
    amount_fen  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'paid',    -- paid/ticketed/refunding/refunded/closed
    created_at  TEXT NOT NULL,
    paid_at     TEXT,
    ticket_no   TEXT,
    FOREIGN KEY (terminal_id) REFERENCES terminals(id)
);

CREATE TABLE IF NOT EXISTS ticket_issues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no    TEXT NOT NULL,
    order_no     TEXT NOT NULL,
    terminal_id  TEXT NOT NULL,
    segment_id   INTEGER,
    issued_at    TEXT NOT NULL,
    flag         TEXT NOT NULL DEFAULT 'ok',     -- ok/duplicate/reversed/void/manual
    duplicate_of TEXT,
    work_order   TEXT
);
-- 同一张票号只允许一张有效票(ok/manual);重复出票(duplicate)是同号重打,允许留痕
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_no_valid
    ON ticket_issues(ticket_no) WHERE flag IN ('ok','manual');

CREATE TABLE IF NOT EXISTS fault_work_orders (
    id               TEXT PRIMARY KEY,
    terminal_id      TEXT NOT NULL,
    kind             TEXT NOT NULL, -- no_paper/jam/payment_no_ticket/dup_issue/refund_timeout/roll_reversed/offline
    status           TEXT NOT NULL DEFAULT 'open', -- open/in_review/resolved
    related_order    TEXT,
    description      TEXT NOT NULL,
    assignee         TEXT,
    resolution       TEXT,
    manual_ticket_no TEXT,       -- 人工补票号,必须挂在工单下
    created_at       TEXT NOT NULL,
    resolved_at      TEXT
);

CREATE TABLE IF NOT EXISTS replenish_tasks (
    id             TEXT PRIMARY KEY,
    terminal_id    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending', -- pending/locked/done/cancelled
    locked_by      TEXT,
    locked_at      TEXT,
    completed_by   TEXT,
    completed_at   TEXT,
    old_batch_id   TEXT,
    new_batch_id   TEXT,
    counter_before INTEGER,
    counter_after  INTEGER,
    photo_before   TEXT,
    photo_after    TEXT,
    scan_code      TEXT,          -- 开柜扫码凭证
    note           TEXT,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replenish_routes (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    task_ids   TEXT NOT NULL,     -- JSON 数组
    status     TEXT NOT NULL DEFAULT 'planned', -- planned/in_progress/done
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
    id          TEXT PRIMARY KEY,
    order_no    TEXT NOT NULL UNIQUE,  -- 一张原订单最多退款一次
    amount_fen  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected/refunded/timeout
    applicant   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    decision    TEXT,
    decided_by  TEXT,
    created_at  TEXT NOT NULL,
    decided_at  TEXT,
    refunded_at TEXT
);

-- 复核队列:扣款未出票/重复出票/退款超时/纸卷倒装/设备离线
CREATE TABLE IF NOT EXISTS review_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL, -- payment_no_ticket/dup_issue/refund_timeout/roll_reversed/offline
    ref_type    TEXT NOT NULL, -- order/work_order/refund/terminal
    ref_id      TEXT NOT NULL,
    terminal_id TEXT,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending/reviewing/resolved/dismissed
    detail      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    resolved_at TEXT,
    resolution  TEXT
);

-- 设备回执:终端上报的每条事件都落本地文件,并在此登记
CREATE TABLE IF NOT EXISTS device_receipts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL UNIQUE,
    terminal_id TEXT NOT NULL,
    kind        TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    synced      INTEGER NOT NULL DEFAULT 1
);

-- 离线事件补传队列
CREATE TABLE IF NOT EXISTS event_spool (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    terminal_id TEXT NOT NULL,
    event_id    TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    synced_at   TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' -- pending/synced
);

CREATE TABLE IF NOT EXISTS operators (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    role     TEXT NOT NULL -- replenisher/supervisor/finance/viewer
);
"""


def connect(db_path=None):
    path = db_path or config.DB_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(conn=None):
    own = conn is None
    conn = conn or connect()
    conn.executescript(SCHEMA)
    seed_operators(conn)
    if own:
        conn.close()


def seed_operators(conn):
    rows = [
        ("u_lin",  "林补给", "replenisher"),
        ("u_zhao", "赵补给", "replenisher"),
        ("u_wang", "王主管", "supervisor"),
        ("u_qian", "钱财务", "finance"),
    ]
    for oid, name, role in rows:
        conn.execute(
            "INSERT OR IGNORE INTO operators(id,name,role) VALUES(?,?,?)",
            (oid, name, role),
        )


def rows_to_dicts(rows):
    return [dict(r) for r in rows]
