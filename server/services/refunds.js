'use strict';
// 退款：只允许对应原订单一次；权限校验；超时进入复核队列；证据链快照。
const { ts, uid } = require('../util');
const faults = require('./faults');
const receiptsMod = require('../receipts');

const REFUNDABLE = new Set(['paid', 'ticket_failed', 'issued']); // 只有真实扣款的订单可退

class RefundError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function getRefund(db, id) {
  return db.prepare('SELECT * FROM refunds WHERE id=?').get(id);
}
function refundByOrder(db, orderId) {
  return db.prepare('SELECT * FROM refunds WHERE order_id=?').get(orderId);
}

function listRefunds(db, { status } = {}) {
  let sql = `SELECT r.*, o.terminal_id, o.item order_item, o.pay_ref, t.name terminal_name
             FROM refunds r JOIN orders o ON o.id=r.order_id
             LEFT JOIN terminals t ON t.id=o.terminal_id WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND r.status=?'; args.push(status); }
  sql += ' ORDER BY r.created_at DESC';
  return db.prepare(sql).all(...args);
}

// 构造纵向证据链：原订单 -> 支付 -> 票据 -> 设备回执 -> 工单 -> 处理动作
function buildEvidence(db, orderId, action) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const paymentRow = db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY created_at').get(orderId);
  const ticketsRows = db.prepare('SELECT * FROM tickets WHERE order_id=? ORDER BY ticket_no').all(orderId);
  const recRows = db.prepare('SELECT * FROM device_receipts WHERE ref_type=? AND ref_id=? ORDER BY created_at')
    .all('order', orderId);
  const faultRows = db.prepare('SELECT id, kind, status, summary, severity FROM fault_tickets WHERE order_id=?').all(orderId);
  return {
    action, at: ts(),
    original_order: order && {
      id: order.id, terminal: order.terminal_id, item: order.item,
      amount_fen: order.amount, status: order.status, pay_ref: order.pay_ref, created_at: order.created_at
    },
    payment: paymentRow && { ref: paymentRow.ref, status: paymentRow.status, amount_fen: paymentRow.amount, at: paymentRow.created_at },
    tickets: ticketsRows.map((t) => ({ code: t.ticket_code, type: t.issue_type, status: t.status, at: t.issued_at })),
    device_receipts: recRows.map((r) => ({ kind: r.kind, file: r.file_path, at: r.created_at })),
    fault_tickets: faultRows
  };
}

function persistEvidenceFile(terminalId, orderId, evidence) {
  const file = receiptsMod.writeJsonReceipt(terminalId || 'NA', 'refund', { orderId, evidence });
  return file;
}

// 发起退款（权限校验）
function requestRefund(db, { orderId, reason, reviewer, source = 'manual' }) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) throw new RefundError('E_ORDER_MISSING', '原订单不存在，无法退款');
  if (order.status === 'refunded') throw new RefundError('E_ALREADY_REFUNDED', '订单已退款，不能重复退款');
  if (!order.pay_ref || !REFUNDABLE.has(order.status)) {
    throw new RefundError('E_NOT_REFUNDABLE', `订单状态 ${order.status} 未真实扣款，不允许退款`);
  }

  const exist = refundByOrder(db, orderId);
  if (exist && ['requested', 'approved', 'success'].includes(exist.status)) {
    throw new RefundError('E_REFUND_EXISTS', '该原订单已存在退款，每单只允许退款一次');
  }

  let id;
  if (exist) {
    // 之前超时/驳回的记录：超时单可重新发起
    id = exist.id;
    db.prepare("UPDATE refunds SET reason=?, status='requested', reviewer=?, source=?, decided_at=NULL, created_at=? WHERE id=?")
      .run(reason, reviewer, source, ts(), id);
  } else {
    id = uid('RF');
    db.prepare(`INSERT INTO refunds(id, order_id, amount, reason, status, reviewer, source, created_at)
                VALUES (?,?,?,?, 'requested', ?, ?, ?)`)
      .run(id, orderId, order.amount, reason, reviewer, source, ts());
  }
  return getRefund(db, id);
}

// 审批：approve（通过并退款）/ reject（驳回）
function decideRefund(db, { id, action, reviewer }) {
  const r = getRefund(db, id);
  if (!r) throw new RefundError('E_REFUND_MISSING', '退款单不存在');
  if (!['requested', 'timeout'].includes(r.status)) {
    throw new RefundError('E_STATE', `退款单状态 ${r.status} 不可审批`);
  }
  // 职责分离：发起人不能审批自己的退款
  if (r.reviewer && r.status === 'requested' && reviewer === r.reviewer) {
    throw new RefundError('E_SOD', '发起人与审批人不能为同一人，请由主管复核');
  }
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.order_id);
  if (action === 'approve') {
    if (order.status === 'refunded') throw new RefundError('E_ALREADY_REFUNDED', '订单已退款，不能重复退款');
    const evidence = buildEvidence(db, r.order_id, 'approve');
    const file = persistEvidenceFile(order.terminal_id, r.order_id, evidence);
    evidence.evidence_file = file;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE refunds SET status='success', reviewer=?, decided_at=?, evidence=? WHERE id=?")
        .run(reviewer, ts(), JSON.stringify(evidence), id);
      db.prepare("UPDATE orders SET status='refunded', updated_at=? WHERE id=?").run(ts(), r.order_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else if (action === 'reject') {
    const evidence = buildEvidence(db, r.order_id, 'reject');
    db.prepare("UPDATE refunds SET status='rejected', reviewer=?, decided_at=?, evidence=? WHERE id=?")
      .run(reviewer, ts(), JSON.stringify(evidence), id);
  } else {
    throw new RefundError('E_ACTION', '未知审批动作');
  }
  return getRefund(db, id);
}

// 模拟退款渠道超时：挂起退款单并入“退款超时”复核队列
function timeoutRefund(db, id) {
  const r = getRefund(db, id);
  if (!r || r.status !== 'requested') throw new RefundError('E_STATE', '仅处理中的退款可置超时');
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.order_id);
  db.prepare("UPDATE refunds SET status='timeout' WHERE id=?").run(id);
  const fault = faults.openFault(db, {
    terminalId: order.terminal_id, kind: 'offline', severity: 'normal',
    summary: `订单 ${order.id} 退款渠道超时未确认`, orderId: order.id
  });
  faults.enqueueReview(db, {
    category: 'refund_timeout', terminalId: order.terminal_id, orderId: order.id, faultId: fault.id,
    note: `退款单 ${id} 超时，待人工核验`
  });
  return getRefund(db, id);
}

// 退款详情（证据链）
function refundEvidence(db, id) {
  const r = getRefund(db, id);
  if (!r) return null;
  const snapshot = r.evidence ? JSON.parse(r.evidence) : null;
  const live = buildEvidence(db, r.order_id, 'view');
  return { refund: r, snapshot, live };
}

module.exports = {
  RefundError, requestRefund, decideRefund, timeoutRefund,
  listRefunds, getRefund, refundByOrder, refundEvidence, buildEvidence
};
