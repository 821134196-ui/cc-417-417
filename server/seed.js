'use strict';
// 演示数据：终端、纸卷库存、号段、出票/卡纸/未出票/退款/离线/倒装等场景。
const { ts, uid } = require('./util');
const { payment, printer } = require('./adapters');
const terms = require('./services/terminals');
const tickets = require('./services/tickets');
const orders = require('./services/orders');
const faults = require('./services/faults');
const refunds = require('./services/refunds');
const routes = require('./services/routes');
const offline = require('./services/offline');

function isSeeded(db) {
  return db.prepare('SELECT COUNT(*) c FROM terminals').get().c > 0;
}

async function seed(db) {
  if (isSeeded(db)) return { skipped: true };

  const now = Date.now();
  let req = 0;
  const requestId = () => `REQ-${now}-${String(++req).padStart(3, '0')}`;

  // ---------- 终端 ----------
  const terminalDefs = [
    ['T-001', '东站枢纽自助机 1 号', '火车东站 · 东广场', 18, 22, 1, 1, 700],
    ['T-002', '东站枢纽自助机 2 号', '火车东站 · 候车厅', 30, 30, 1, 1, 420],
    ['T-003', '西站南广场自助机', '西站 · 南广场', 62, 26, 1, 1, 60],
    ['T-004', '北站售票大厅自助机', '北站 · 售票厅', 78, 60, 1, 0, 300],
    ['T-005', '机场 T2 自助机', '机场 T2 · 到达口', 52, 74, 1, 1, 850],
    ['T-006', '体育馆临时候车点', '体育馆 · 北门', 86, 40, 1, 1, 0]
  ];
  for (const [id, name, loc, x, y, online, enabled, paper] of terminalDefs) {
    db.prepare(`INSERT INTO terminals(id,name,location,x,y,online,enabled,paper_remaining,paper_capacity,last_refill_at,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, loc, x, y, online, enabled, paper, 1000, ts(), ts());
  }

  // ---------- 纸卷批次库存 ----------
  const rollDefs = [
    ['B2026-0901', 1000, 'in_stock'], ['B2026-0902', 1000, 'in_stock'],
    ['B2026-0903', 1000, 'in_stock'], ['B2026-0904', 800, 'in_stock'],
    ['B2026-0905', 1000, 'in_stock'], ['B2026-0906', 1000, 'in_stock'],
    ['B2026-0811', 1000, 'used'], ['B2026-0812', 1000, 'used']
  ];
  const rollIds = {};
  for (const [batch, cap, status] of rollDefs) {
    const id = uid('R');
    db.prepare(`INSERT INTO paper_rolls(id,batch_no,capacity,status,terminal_id,installed_at,created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, batch, cap, status, null, null, ts());
    rollIds[batch] = id;
  }

  // ---------- 号段 ----------
  tickets.assignRange(db, 'T-001', { prefix: 'A', startNo: 100001, endNo: 100600 });
  tickets.assignRange(db, 'T-002', { prefix: 'B', startNo: 200001, endNo: 200600 });
  tickets.assignRange(db, 'T-003', { prefix: 'C', startNo: 300001, endNo: 300600 });
  tickets.assignRange(db, 'T-004', { prefix: 'D', startNo: 400001, endNo: 400600 });
  tickets.assignRange(db, 'T-005', { prefix: 'E', startNo: 500001, endNo: 500600 });
  tickets.assignRange(db, 'T-006', { prefix: 'F', startNo: 600001, endNo: 600030 });

  // ---------- 正常出票（T-001 出 3 张，演示连续号段） ----------
  for (let i = 0; i < 3; i++) {
    await orders.purchase(db, {
      terminalId: 'T-001', requestId: requestId(),
      item: ['东站→西站 单程票', '东站→北站 单程票', '东站→机场 单程票'][i],
      amountFen: [5500, 6800, 12000][i]
    });
  }
  // T-005 正常出 2 张
  for (const item of [['机场→东站 商务座', 38000], ['机场→西站 单程票', 21000]]) {
    await orders.purchase(db, { terminalId: 'T-005', requestId: requestId(), item: item[0], amountFen: item[1] });
  }

  // ---------- 卡纸：扣款成功未出票（T-003） ----------
  printer.jamTerminal = 'T-003';
  const jam = await orders.purchase(db, {
    terminalId: 'T-003', requestId: requestId(), item: '西站→东站 单程票', amountFen: 7200
  });
  printer.jamTerminal = null; // 硬件仍停用（enabled=0），等待补给员处理

  // ---------- 断纸：T-006 纸卷为 0，扣款成功未出票 ----------
  const nopaper = await orders.purchase(db, {
    terminalId: 'T-006', requestId: requestId(), item: '体育馆→东站 临客票', amountFen: 3500
  });

  // ---------- 离线：T-004 离线期间扣款未出票 ----------
  offline.markOffline(db, 'T-004', '演示：心跳超时');
  const off = await orders.purchase(db, {
    terminalId: 'T-004', requestId: requestId(), item: '北站→东站 单程票', amountFen: 4600
  });
  // 恢复在线并补传一条计数器事件（去重演示由测试覆盖）
  offline.markOnline(db, 'T-004');
  offline.syncEvent(db, 'T-004', {
    clientEventId: 'EVT-DEMO-0001', kind: 'counter',
    payload: { paper_remaining: 298 }, eventTime: ts()
  });
  terms.stopTerminal(db, 'T-004'); // 未出票工单未处理完，保持停用

  // ---------- 重复出票（T-005 硬件重试导致一张订单出两张） ----------
  const issuedOnT5 = orders.listOrders(db, { terminalId: 'T-005', status: 'issued', limit: 1 })[0];
  orders.duplicateIssue(db, issuedOnT5.id);

  // ---------- 退款三连：成功 / 超时待复核 / 申请中 ----------
  // 1) 卡纸订单 -> 已成功退款
  const r1 = refunds.requestRefund(db, { orderId: jam.order.id, reason: '卡纸未出票，旅客申请退款', reviewer: '客服-周敏' });
  refunds.decideRefund(db, { id: r1.id, action: 'approve', reviewer: '主管-郑凯' });

  // 2) 离线订单 -> 退款渠道超时
  const r2 = refunds.requestRefund(db, { orderId: off.order.id, reason: '离线未出票', reviewer: '客服-周敏' });
  refunds.timeoutRefund(db, r2.id);

  // 3) 断纸订单 -> 退款申请中，等待审批
  refunds.requestRefund(db, { orderId: nopaper.order.id, reason: '断纸未出票，旅客现场申请', reviewer: '客服-林珊' });

  // ---------- 纸卷倒装：T-002 补给任务 ----------
  const routeA = routes.createRoute(db, { name: '9 月 28 日 · 城东补给线', terminalIds: ['T-002', 'T-003', 'T-006'] });
  const [taskT2, taskT3, taskT6] = db.prepare('SELECT * FROM refill_tasks WHERE route_id=? ORDER BY seq').all(routeA.id);

  // T-002：赵磊领单 -> 扫码 -> 倒装上报
  routes.claimTask(db, taskT2.id, '补给员-赵磊');
  routes.scanOpen(db, taskT2.id, { operator: '补给员-赵磊', code: getTaskCode(db, taskT2.id) });
  routes.completeRefill(db, taskT2.id, {
    operator: '补给员-赵磊', rollId: rollIds['B2026-0904'], reversed: true, note: '演示：纸卷倒装'
  });

  // T-003：钱芳领单（卡纸终端，演示任务锁定中）
  routes.claimTask(db, taskT3.id, '补给员-钱芳');

  // T-006：王磊领单 -> 扫码开柜，等待装卷
  routes.claimTask(db, taskT6.id, '补给员-王磊');
  routes.scanOpen(db, taskT6.id, { operator: '补给员-王磊', code: getTaskCode(db, taskT6.id) });

  // 另一条排队路线
  routes.createRoute(db, { name: '9 月 29 日 · 城西补给线', terminalIds: ['T-004', 'T-001'] });

  return {
    skipped: false,
    highlights: {
      jamOrder: jam.order.id,
      nopaperOrder: nopaper.order.id,
      offlineOrder: off.order.id,
      routeId: routeA.id
    }
  };
}

function getTaskCode(db, taskId) {
  return db.prepare('SELECT scan_code FROM refill_tasks WHERE id=?').get(taskId).scan_code;
}

module.exports = { seed, isSeeded };
