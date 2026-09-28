'use strict';
// 故障工单与复核队列
const { ts, uid } = require('../util');

const KIND_LABEL = {
  no_paper: '断纸', paper_jam: '卡纸', range_exhausted: '号段用尽',
  roll_reversed: '纸卷倒装', offline: '设备离线',
  paid_no_ticket: '扣款成功未出票', duplicate_ticket: '重复出票'
};
const CATEGORY_LABEL = {
  paid_no_ticket: '扣款成功未出票',
  duplicate_ticket: '重复出票',
  refund_timeout: '退款超时',
  roll_reversed: '纸卷倒装',
  offline: '设备离线'
};

function openFault(db, { terminalId, kind, summary, orderId = null, severity = 'normal' }) {
  // 同终端同类型未关闭工单不重复建
  const exist = db.prepare("SELECT id FROM fault_tickets WHERE terminal_id=? AND kind=? AND status IN ('open','in_repair')")
    .get(terminalId, kind);
  if (exist) return db.prepare('SELECT * FROM fault_tickets WHERE id=?').get(exist.id);
  const id = uid('FT');
  db.prepare(`INSERT INTO fault_tickets(id, terminal_id, kind, severity, status, summary, order_id, created_at)
              VALUES (?,?,?,?,'open',?,?,?)`)
    .run(id, terminalId, kind, severity, summary, orderId, ts());
  return db.prepare('SELECT * FROM fault_tickets WHERE id=?').get(id);
}

function listFaults(db, { status, kind } = {}) {
  let sql = 'SELECT f.*, t.name terminal_name, t.location FROM fault_tickets f JOIN terminals t ON t.id=f.terminal_id WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND f.status=?'; args.push(status); }
  if (kind) { sql += ' AND f.kind=?'; args.push(kind); }
  sql += ' ORDER BY CASE f.severity WHEN \'high\' THEN 0 ELSE 1 END, f.created_at';
  return db.prepare(sql).all(...args);
}

function assignFault(db, id, assignee) {
  db.prepare("UPDATE fault_tickets SET status='in_repair', assignee=? WHERE id=? AND status IN ('open','in_repair')")
    .run(assignee, id);
  return db.prepare('SELECT * FROM fault_tickets WHERE id=?').get(id);
}

function resolveFault(db, id, resolution) {
  db.prepare("UPDATE fault_tickets SET status='resolved', resolved_at=?, resolution=? WHERE id=?")
    .run(ts(), resolution || '已修复', id);
  return db.prepare('SELECT * FROM fault_tickets WHERE id=?').get(id);
}

function enqueueReview(db, { category, terminalId, orderId = null, faultId = null, note = '' }) {
  // 同类别同订单去重
  if (orderId) {
    const dup = db.prepare("SELECT id FROM review_queue WHERE category=? AND order_id=? AND status='pending'")
      .get(category, orderId);
    if (dup) return db.prepare('SELECT * FROM review_queue WHERE id=?').get(dup.id);
  }
  const id = uid('RV');
  db.prepare(`INSERT INTO review_queue(id, category, terminal_id, order_id, fault_id, note, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, category, terminalId, orderId, faultId, note, ts());
  return db.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
}

function listReview(db, { status = 'pending', category } = {}) {
  let sql = `SELECT q.*, t.name terminal_name, o.amount order_amount, o.status order_status,
                    o.item order_item FROM review_queue q
             LEFT JOIN terminals t ON t.id=q.terminal_id
             LEFT JOIN orders o ON o.id=q.order_id WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND q.status=?'; args.push(status); }
  if (category) { sql += ' AND q.category=?'; args.push(category); }
  sql += ' ORDER BY q.created_at';
  return db.prepare(sql).all(...args);
}

function settleReview(db, id, status, handler, note) {
  db.prepare('UPDATE review_queue SET status=?, handled_at=?, handler=?, note=? WHERE id=?')
    .run(status, ts(), handler, note || null, id);
  return db.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
}

module.exports = {
  KIND_LABEL, CATEGORY_LABEL,
  openFault, listFaults, assignFault, resolveFault,
  enqueueReview, listReview, settleReview
};
