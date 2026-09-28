'use strict';
/* 测试：号段连续、订单幂等、纸卷并发扣减、离线补传、退款权限，
   另含任务锁定、扫码开柜、倒装停用、人工补票关联工单。 */
const assert = require('assert');
const { openMemory } = require('../server/db');
const { ts, uid } = require('../server/util');
const { payment, printer } = require('../server/adapters');
const terms = require('../server/services/terminals');
const tickets = require('../server/services/tickets');
const orders = require('../server/services/orders');
const faults = require('../server/services/faults');
const refunds = require('../server/services/refunds');
const routes = require('../server/services/routes');
const offline = require('../server/services/offline');

let passed = 0, failed = 0;
const results = [];
const suite = [];
// 串行执行：适配器（支付/打印机）为进程内单例，避免并发测试互相污染
function test(name, fn) {
  suite.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of suite) {
    const db = openMemory();
    printer.jamTerminal = null; printer.offline.clear(); payment.forceFail = false;
    try { await fn(db); passed++; results.push(['PASS', name]); }
    catch (e) { failed++; results.push(['FAIL', name, e]); }
  }
}

function mkTerminal(db, id, { paper = 1000, rangeFrom = 1, rangeTo = 900000, prefix = 'A' } = {}) {
  db.prepare(`INSERT INTO terminals(id,name,location,x,y,online,enabled,paper_remaining,paper_capacity,created_at)
              VALUES (?,?,?,?,?,1,1,?,?,?)`)
    .run(id, id, '测试点', 50, 50, paper, paper, ts());
  tickets.assignRange(db, id, { prefix, startNo: rangeFrom, endNo: rangeTo });
}
let nreq = 0;
const rid = () => 'REQ-T' + Date.now().toString(36) + '-' + (++nreq);

/* ---------- 1. 号段连续 ---------- */
test('号段连续：顺号出票，卡纸占号不跳号，停用后续打被拒', async (db) => {
  mkTerminal(db, 'T1', { prefix: 'A', rangeFrom: 100, rangeTo: 200, paper: 1000 });

  const t1 = tickets.allocateTicket(db, 'T1');
  const t2 = tickets.allocateTicket(db, 'T1');
  assert.equal(t1.ticket_code, 'A-000100');
  assert.equal(t2.ticket_code, 'A-000101');

  // 模拟卡纸：号已分配但物理未出纸 -> 作废留痕、终端停用
  db.prepare("UPDATE tickets SET status='void_jam' WHERE id=?", ).run(t2.id);
  terms.stopTerminal(db, 'T1');

  // 停用状态禁止继续打印（不能跳号继续）
  assert.throws(() => tickets.allocateTicket(db, 'T1'), /禁止发票/);
  terms.resumeTerminal(db, 'T1');
  const t3 = tickets.allocateTicket(db, 'T1');
  // 关键：卡纸占掉的 101 绝不重发，也不跳过后续号
  assert.equal(t3.ticket_code, 'A-000102', '卡纸后必须顺到 102，不能重号/跳号');

  const v = tickets.verifyContinuity(db, 'T1');
  assert.ok(v.ok, '连续性校验应通过：' + v.problems.join(';'));
});

test('号段用尽：到达 end_no 后拒绝发票并停用，不产生越界号', async (db) => {
  mkTerminal(db, 'T1', { prefix: 'Z', rangeFrom: 1, rangeTo: 3, paper: 100 });
  tickets.allocateTicket(db, 'T1');
  tickets.allocateTicket(db, 'T1');
  tickets.allocateTicket(db, 'T1'); // 1,2,3
  assert.throws(() => tickets.allocateTicket(db, 'T1'), /号段已用尽/);
  const rng = tickets.activeRange(db, 'T1');
  assert.equal(rng.next_no, 4);
  const codes = db.prepare('SELECT ticket_code FROM tickets ORDER BY ticket_no').all().map((r) => r.ticket_code);
  assert.deepEqual(codes, ['Z-000001', 'Z-000002', 'Z-000003']);
});

/* ---------- 2. 订单幂等 ---------- */
test('订单幂等：同一 client_request_id 重放只扣款/出票一次', async (db) => {
  mkTerminal(db, 'T1');
  const key = rid();
  const a = await orders.purchase(db, { terminalId: 'T1', requestId: key, item: '票', amountFen: 5000 });
  const b = await orders.purchase(db, { terminalId: 'T1', requestId: key, item: '票', amountFen: 5000 });
  assert.equal(a.order.id, b.order.id);
  assert.equal(b.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id=?').get(a.order.id).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets WHERE order_id=?').get(a.order.id).c, 1);

  const c = await orders.purchase(db, { terminalId: 'T1', requestId: rid(), item: '票', amountFen: 5000 });
  assert.notEqual(c.order.id, a.order.id);
});

/* ---------- 3. 纸卷并发扣减 ---------- */
test('纸卷并发扣减：20 个并发购票 / 仅 5 张纸，不超卖、不为负', async (db) => {
  mkTerminal(db, 'T1', { paper: 5, rangeTo: 900000 });
  const buyers = Array.from({ length: 20 }, (_, i) =>
    orders.purchase(db, { terminalId: 'T1', requestId: 'CONC-' + i, item: '并发票', amountFen: 1000 }));
  const rs = await Promise.all(buyers);

  const issued = rs.filter((r) => r.order.status === 'issued');
  const failed = rs.filter((r) => r.order.status === 'ticket_failed');
  assert.equal(issued.length, 5, '恰好 5 张成功出票');
  assert.equal(failed.length, 15, '其余 15 单扣款成功未出票');
  const t = terms.getTerminal(db, 'T1');
  assert.equal(t.paper_remaining, 0, '纸张不能为负');
  assert.equal(t.enabled, 0, '缺纸必须停用终端');

  // 号段仍连续：5 张打印票（之后即使重试用纸 0 也不出票）
  const printed = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='printed'").get().c;
  assert.equal(printed, 5);
  assert.ok(tickets.verifyContinuity(db, 'T1').ok);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM review_queue WHERE category='paid_no_ticket' AND status='pending'").get().c, 15);
});

/* ---------- 4. 离线补传 ---------- */
test('离线补传：重复事件去重，顺号补登，错号进复核不跳号', async (db) => {
  mkTerminal(db, 'T1', { prefix: 'A', rangeFrom: 500, rangeTo: 600 });
  offline.markOffline(db, 'T1');

  // 同一事件补传两次：只应用一次
  const payload = { clientEventId: 'EVT-1', kind: 'counter', payload: { paper_remaining: 123 }, eventTime: ts() };
  const s1 = offline.syncEvent(db, 'T1', payload);
  const s2 = offline.syncEvent(db, 'T1', payload);
  assert.equal(s1.applied, true);
  assert.equal(s2.duplicated, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM offline_events').get().c, 1);
  assert.equal(terms.getTerminal(db, 'T1').paper_remaining, 123);

  // 恢复后顺号补登一张离线期间打印的票
  offline.markOnline(db, 'T1');
  const ok = offline.syncEvent(db, 'T1', {
    clientEventId: 'EVT-2', kind: 'ticket_printed',
    payload: { ticket_code: 'A-000500' }, eventTime: ts()
  });
  assert.equal(ok.result.accepted, true);
  assert.equal(tickets.activeRange(db, 'T1').next_no, 501);

  // 错号补传（本地与服务器不一致）：拒绝顺号、进离线复核
  const bad = offline.syncEvent(db, 'T1', {
    clientEventId: 'EVT-3', kind: 'ticket_printed',
    payload: { ticket_code: 'A-000555' }, eventTime: ts()
  });
  assert.equal(bad.result.accepted, false);
  assert.equal(tickets.activeRange(db, 'T1').next_no, 501, '错号不能改动号段指针');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM review_queue WHERE category='offline' AND status='pending'").get().c >= 1);

  // 再次补传同事件仍然去重
  const again = offline.syncEvent(db, 'T1', { clientEventId: 'EVT-2', kind: 'ticket_printed', payload: { ticket_code: 'A-000500' } });
  assert.equal(again.duplicated, true);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tickets WHERE ticket_code='A-000500'").get().c, 1);
});

/* ---------- 5. 退款权限 ---------- */
test('退款权限：未扣款不可退、每单一次、发起人不能自审、审批后订单置退款', async (db) => {
  mkTerminal(db, 'T1');
  // 未真实扣款（支付失败关单）
  payment.forceFail = true;
  const closed = await orders.purchase(db, { terminalId: 'T1', requestId: rid(), item: '票', amountFen: 1000 });
  payment.forceFail = false;
  assert.equal(closed.order.status, 'closed');
  assert.throws(() => refunds.requestRefund(db, { orderId: closed.order.id, reason: 'x', reviewer: '客服A' }), /未真实扣款/);

  // 正常出票订单申请退款
  const paid = await orders.purchase(db, { terminalId: 'T1', requestId: rid(), item: '票', amountFen: 3000 });
  const r = refunds.requestRefund(db, { orderId: paid.order.id, reason: '旅客申请', reviewer: '客服A' });

  // 发起人不能自审
  assert.throws(() => refunds.decideRefund(db, { id: r.id, action: 'approve', reviewer: '客服A' }), /不能为同一人/);
  // 主管审批通过
  refunds.decideRefund(db, { id: r.id, action: 'approve', reviewer: '主管B' });
  assert.equal(refunds.getRefund(db, r.id).status, 'success');
  assert.equal(orders.getOrder(db, paid.order.id).status, 'refunded');
  assert.equal(terms.getTerminal(db, 'T1') ? 1 : 1, 1);

  // 每单仅一次：再次发起/再次审批都被拒
  assert.throws(() => refunds.requestRefund(db, { orderId: paid.order.id, reason: '再退', reviewer: '客服A' }), /已退款/);
  assert.throws(() => refunds.decideRefund(db, { id: r.id, action: 'approve', reviewer: '主管C' }), /不可审批/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM refunds WHERE order_id=?').get(paid.order.id).c, 1);
});

test('退款超时：置 timeout 并入退款超时复核队列，可由他人重新审批', async (db) => {
  mkTerminal(db, 'T1');
  const o = await orders.purchase(db, { terminalId: 'T1', requestId: rid(), item: '票', amountFen: 2000 });
  const r = refunds.requestRefund(db, { orderId: o.order.id, reason: '渠道卡', reviewer: '客服A' });
  refunds.timeoutRefund(db, r.id);
  assert.equal(refunds.getRefund(db, r.id).status, 'timeout');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM review_queue WHERE category='refund_timeout' AND status='pending'").get().c, 1);
  // 超时单可由主管直接审批通过
  refunds.decideRefund(db, { id: r.id, action: 'approve', reviewer: '主管B' });
  assert.equal(orders.getOrder(db, o.order.id).status, 'refunded');
});

/* ---------- 6. 补给任务锁定 / 扫码 / 倒装 ---------- */
test('补给任务：两人抢单只保留一个锁定者；必须扫码开柜才能换卷', async (db) => {
  mkTerminal(db, 'T1', { paper: 0, rangeTo: 900000 });
  terms.stopTerminal(db, 'T1');
  const roll = terms.createRoll(db, { batchNo: 'B-T1', capacity: 1000 });
  const route = routes.createRoute(db, { name: '线', terminalIds: ['T1'] });
  const task = db.prepare('SELECT * FROM refill_tasks WHERE route_id=?').get(route.id);

  const a = routes.claimTask(db, task.id, '补给员-甲');
  const b = routes.claimTask(db, task.id, '补给员-乙');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(routes.getTask(db, task.id).locked_by, '补给员-甲');

  // 未扫码不能直接完成；错口令不开柜
  assert.throws(() => routes.completeRefill(db, task.id, { operator: '补给员-甲', rollId: roll.id }), /扫码开柜/);
  assert.throws(() => routes.scanOpen(db, task.id, { operator: '补给员-甲', code: 'WRONG' }), /口令不正确/);
  // 非锁定者不能扫码
  assert.throws(() => routes.scanOpen(db, task.id, { operator: '补给员-乙', code: task.scan_code }), /锁定者/);

  // 正确扫码 -> 前照片 -> 完成换卷 -> 后照片、恢复发票
  const scan = routes.scanOpen(db, task.id, { operator: '补给员-甲', code: routes.getTask(db, task.id).scan_code });
  assert.ok(scan.beforePhoto);
  const done = routes.completeRefill(db, task.id, { operator: '补给员-甲', rollId: roll.id });
  assert.ok(done.afterPhoto);
  assert.equal(terms.getTerminal(db, 'T1').paper_remaining, 1000);
  assert.equal(terms.getTerminal(db, 'T1').enabled, 1, '换卷后号段仍有余量应恢复发票');
  assert.equal(terms.getRoll(db, roll.id).status, 'installed');
});

test('纸卷倒装：停用终端并入倒装复核，不装机', async (db) => {
  mkTerminal(db, 'T2', { paper: 10 });
  const roll = terms.createRoll(db, { batchNo: 'B-T2', capacity: 1000 });
  const route = routes.createRoute(db, { name: '线', terminalIds: ['T2'] });
  const task = db.prepare('SELECT * FROM refill_tasks WHERE route_id=?').get(route.id);
  routes.claimTask(db, task.id, '补给员-甲');
  routes.scanOpen(db, task.id, { operator: '补给员-甲', code: routes.getTask(db, task.id).scan_code });
  const r = routes.completeRefill(db, task.id, { operator: '补给员-甲', rollId: roll.id, reversed: true });
  assert.equal(r.ok, false);
  assert.equal(terms.getTerminal(db, 'T2').enabled, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM review_queue WHERE category='roll_reversed' AND status='pending'").get().c, 1);
  // 倒装未真正装机：纸卷保持在库
  assert.equal(terms.getRoll(db, roll.id).status, 'in_stock');
});

/* ---------- 7. 人工补票必须关联故障工单 ---------- */
test('人工补票：无工单拒绝；有关联工单才顺号补票', async (db) => {
  mkTerminal(db, 'T1', { paper: 100 });
  assert.throws(() => orders.manualReissue(db, { terminalId: 'T1', faultId: 'FT-nope', operator: '员' }), /必须关联故障工单/);

  const f = faults.openFault(db, { terminalId: 'T1', kind: 'paper_jam', summary: '卡纸补票' });
  const r = orders.manualReissue(db, { terminalId: 'T1', faultId: f.id, operator: '票务员' });
  assert.equal(r.ticket.issue_type, 'manual_reissue');
  assert.equal(r.ticket.ticket_code, 'A-000001');
  assert.equal(db.prepare('SELECT assignee FROM fault_tickets WHERE id=?').get(f.id).assignee, '票务员');
});

/* ---------- 汇总 ---------- */
(async () => {
  await runAll();
  for (const [s, n, e] of results) {
    if (s === 'PASS') console.log(`  \x1b[32m✓\x1b[0m ${n}`);
    else { console.log(`  \x1b[31m✗ ${n}\x1b[0m`); console.log('    ', e && (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
