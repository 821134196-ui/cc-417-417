'use strict';
// 收款订单：幂等下单 -> 模拟扣款 -> 连续号段出票 -> 模拟打印。
// 扣款成功但断纸/卡纸/号段尽/离线，一律进故障+复核，绝不跳号续打。
const { ts, uid } = require('../util');
const { payment, printer } = require('../adapters');
const tickets = require('./tickets');
const terms = require('./terminals');
const faults = require('./faults');
const receipts = require('../receipts');

function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
}
function findByRequestId(db, requestId) {
  return db.prepare('SELECT * FROM orders WHERE client_request_id=?').get(requestId);
}

function listOrders(db, { status, terminalId, limit = 200 } = {}) {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status=?'; args.push(status); }
  if (terminalId) { sql += ' AND terminal_id=?'; args.push(terminalId); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);
  return db.prepare(sql).all(...args);
}

// 幂等购票：相同 client_request_id 重放只返回原订单，不会二次扣款/出票。
async function purchase(db, { terminalId, requestId, item, amountFen }) {
  const existing = findByRequestId(db, requestId);
  if (existing) return { order: existing, idempotent: true };

  const id = uid('OD');
  const now = ts();
  db.prepare(`INSERT INTO orders(id, terminal_id, client_request_id, item, amount, status, created_at, updated_at)
              VALUES (?,?,?,?,?, 'created', ?, ?)`)
    .run(id, terminalId, requestId, item, amountFen, now, now);

  // 1) 扣款（支付侧自身幂等）
  const pay = await payment.charge(db, { orderId: id, amountFen, idempotencyKey: 'charge:' + requestId });
  if (!pay.ok) {
    db.prepare("UPDATE orders SET status='closed', updated_at=? WHERE id=?").run(ts(), id);
    return { order: getOrder(db, id), idempotent: false, payFailed: true };
  }
  db.prepare("UPDATE orders SET status='paid', pay_ref=?, paid_at=?, updated_at=? WHERE id=?")
    .run(pay.ref, ts(), ts(), id);

  // 2) 设备离线：无法出票
  if (!printer.isOnline(terminalId)) {
    return await failTicket(db, id, 'offline', '设备离线，扣款成功未出票（待补传/退款）');
  }

  // 3) 分配连续票号并扣纸（事务，绝不跳号）
  let ticket;
  try {
    ticket = tickets.allocateTicket(db, terminalId, { orderId: id, issueType: 'sale' });
  } catch (e) {
    if (e.code === 'E_NO_PAPER') return await failTicket(db, id, 'no_paper', '纸卷用尽，扣款成功未出票');
    if (e.code === 'E_RANGE_EXHAUSTED' || e.code === 'E_RANGE_NONE') {
      return await failTicket(db, id, 'range_exhausted', '票据号段用尽，停止发票');
    }
    if (e.code === 'E_TERMINAL_STOPPED') {
      return await failTicket(db, id, e.code, '终端已停用（卡纸/断纸），禁止发票');
    }
    throw e;
  }

  // 4) 物理打印
  const printed = await printer.print(terminalId, ticket.ticket_code);
  if (!printed.ok) {
    // 卡纸：号已占（连续台账留痕为 void_jam），终端停用，进入复核
    db.prepare("UPDATE tickets SET status='void_jam' WHERE id=?").run(ticket.id);
    return await failTicket(db, id, 'paper_jam', '卡纸：票号已占但未正常出纸，停止发票', ticket.id);
  }

  // 成功出票
  db.prepare("UPDATE orders SET status='issued', ticket_id=?, updated_at=? WHERE id=?")
    .run(ticket.id, ts(), id);
  const file = receipts.writePrintReceipt(terminalId, ticket.ticket_code, id, amountFen / 100);
  receipts.registerReceipt(db, terminalId, 'print', file, 'order', id);
  return { order: getOrder(db, id), ticket: db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id), idempotent: false };
}

async function failTicket(db, orderId, reason, summary, ticketId = null) {
  const order = getOrder(db, orderId);
  terms.stopTerminal(db, order.terminal_id);
  db.prepare("UPDATE orders SET status='ticket_failed', fail_reason=?, ticket_id=COALESCE(?,ticket_id), updated_at=? WHERE id=?")
    .run(reason, ticketId, ts(), orderId);

  const kindMap = {
    no_paper: ['no_paper', 'normal'],
    paper_jam: ['paper_jam', 'high'],
    range_exhausted: ['range_exhausted', 'high'],
    offline: ['offline', 'high'],
    E_TERMINAL_STOPPED: ['paper_jam', 'high']
  };
  const [kind, severity] = kindMap[reason] || ['paid_no_ticket', 'high'];
  const fault = faults.openFault(db, { terminalId: order.terminal_id, kind, severity, summary, orderId });
  faults.enqueueReview(db, {
    category: 'paid_no_ticket', terminalId: order.terminal_id, orderId, faultId: fault.id,
    note: summary
  });

  // 离线另入设备离线复核
  if (reason === 'offline') {
    faults.enqueueReview(db, { category: 'offline', terminalId: order.terminal_id, orderId, faultId: fault.id, note: summary });
  }
  return { order: getOrder(db, orderId), fault, failed: true, reason };
}

// 硬件重试导致的重复出票：同一订单再出一张票，进“重复出票”复核
function duplicateIssue(db, orderId) {
  const order = getOrder(db, orderId);
  if (!order) throw new Error('订单不存在');
  const ticket = tickets.allocateTicket(db, order.terminal_id, { orderId, issueType: 'duplicate' });
  db.prepare("UPDATE tickets SET status='duplicate' WHERE id=?").run(ticket.id);
  const fault = faults.openFault(db, {
    terminalId: order.terminal_id, kind: 'duplicate_ticket', severity: 'high',
    summary: `订单 ${orderId} 被重复出票：${ticket.ticket_code}`, orderId
  });
  faults.enqueueReview(db, {
    category: 'duplicate_ticket', terminalId: order.terminal_id, orderId, faultId: fault.id,
    note: `重复票据 ${ticket.ticket_code}`
  });
  return { ticket, fault };
}

// 人工补票：必须关联故障工单
function manualReissue(db, { terminalId, faultId, operator }) {
  const fault = db.prepare('SELECT * FROM fault_tickets WHERE id=?').get(faultId);
  if (!fault) { const e = new Error('人工补票必须关联故障工单：工单不存在'); e.code = 'E_NO_FAULT'; throw e; }
  if (!['open', 'in_repair'].includes(fault.status)) {
    const e = new Error('故障工单已关闭，不能补票'); e.code = 'E_FAULT_CLOSED'; throw e;
  }
  const ticket = tickets.allocateTicket(db, terminalId, { orderId: fault.order_id, issueType: 'manual_reissue' });
  db.prepare('UPDATE fault_tickets SET assignee=COALESCE(assignee,?), status=? WHERE id=?')
    .run(operator, 'in_repair', faultId);
  return { ticket, fault };
}

// 订单核验视图：订单 + 支付 + 票据 + 工单 + 退款 + 回执
function verification(db, orderId) {
  const order = getOrder(db, orderId);
  if (!order) return null;
  const paymentRow = db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY created_at').get(orderId);
  const ticketRows = db.prepare('SELECT * FROM tickets WHERE order_id=? ORDER BY ticket_no').all(orderId);
  const faultRows = db.prepare('SELECT * FROM fault_tickets WHERE order_id=?').all(orderId);
  const refundRows = db.prepare('SELECT * FROM refunds WHERE order_id=?').all(orderId);
  const receiptRows = db.prepare('SELECT * FROM device_receipts WHERE ref_type=? AND ref_id=? ORDER BY created_at')
    .all('order', orderId);
  return { order, payment: paymentRow, tickets: ticketRows, faults: faultRows, refunds: refundRows, receipts: receiptRows };
}

module.exports = {
  getOrder, findByRequestId, listOrders, purchase,
  duplicateIssue, manualReissue, verification, failTicket
};
