'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, RECEIPT_DIR, ROOT, PORT, HOST } = require('./config');
const terms = require('./services/terminals');
const tickets = require('./services/tickets');
const orders = require('./services/orders');
const faults = require('./services/faults');
const refunds = require('./services/refunds');
const routes = require('./services/routes');
const offlineSvc = require('./services/offline');

function createServer(db) {
  const server = http.createServer(async (req, res) => {
    try {
      await handle(db, req, res);
    } catch (e) {
      const status = e.statusCode || 400;
      sendJson(res, status, { error: e.message, code: e.code || 'E' });
    }
  });
  return server;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handle(db, req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // 本地文件：设备回执（白名单 data/receipts 与 public）
  if (p.startsWith('/files/')) {
    const rel = decodeURIComponent(p.slice('/files/'.length));
    const base = path.resolve(ROOT);
    const file = path.resolve(base, rel);
    if (!file.startsWith(path.resolve(RECEIPT_DIR)) && !file.startsWith(path.resolve(base, 'data'))) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    return serveStatic(res, file);
  }

  if (p === '/' || p === '/index.html') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  if (!p.startsWith('/api/')) {
    const f = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(PUBLIC_DIR) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveStatic(res, f);
    res.writeHead(404); res.end('not found'); return;
  }

  // ---------- API ----------
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  const body = req.method === 'POST' ? await readBody(req) : {};
  const q = Object.fromEntries(url.searchParams);

  const R = await routeApi(db, seg, body, q);
  sendJson(res, 200, R);
}

// 简单路由表
async function routeApi(db, seg, body, q) {
  const [, resource, id, action] = seg;

  // 概览看板
  if (resource === 'overview' && !id) return overview(db);

  // 终端
  if (resource === 'terminals') {
    if (!id) return { terminals: terms.listTerminals(db) };
    if (id === 'map') return { terminals: terms.listTerminals(db) };
    if (action === 'online') { terms.setOnline(db, id, !!body.online); return { ok: true, terminal: terms.getTerminal(db, id) }; }
    if (action === 'stop') { terms.stopTerminal(db, id); return { ok: true }; }
    if (action === 'resume') { terms.resumeTerminal(db, id); return { ok: true }; }
    if (action === 'continuity') return { terminal: id, ...tickets.verifyContinuity(db, id) };
    if (action === 'range') {
      const r = tickets.assignRange(db, id, { prefix: body.prefix, startNo: body.startNo, endNo: body.endNo });
      return { ok: true, range: r };
    }
    return { terminal: terms.getTerminal(db, id) };
  }

  // 纸卷
  if (resource === 'rolls') {
    if (!id) {
      if (Object.keys(body).length) return { ok: true, roll: terms.createRoll(db, body) };
      return { rolls: terms.listRolls(db), inventory: terms.inventory(db) };
    }
    return { roll: terms.getRoll(db, id) };
  }

  // 订单
  if (resource === 'orders') {
    if (!id) return { orders: orders.listOrders(db, q) };
    if (action === 'verify') return orders.verification(db, id);
    if (action === 'duplicate') return orders.duplicateIssue(db, id);
    return { order: orders.getOrder(db, id) };
  }

  // 购票（模拟）
  if (resource === 'purchase') {
    const r = await orders.purchase(db, {
      terminalId: body.terminalId, requestId: body.requestId, item: body.item, amountFen: body.amountFen
    });
    return { ok: true, ...r };
  }

  // 故障工单
  if (resource === 'faults') {
    if (!id) return { faults: faults.listFaults(db, q) };
    if (action === 'assign') return { ok: true, fault: faults.assignFault(db, id, body.operator) };
    if (action === 'resolve') {
      const f = faults.resolveFault(db, id, body.resolution);
      // 修复后若号段/纸张具备则恢复终端
      const t = terms.getTerminal(db, f.terminal_id);
      const range = tickets.activeRange(db, f.terminal_id);
      if (t.paper_remaining > 0 && range && range.next_no <= range.end_no) terms.resumeTerminal(db, f.terminal_id);
      return { ok: true, fault: f };
    }
    return { fault: db.prepare('SELECT * FROM fault_tickets WHERE id=?').get(id) };
  }

  // 人工补票（必须带 faultId）
  if (resource === 'manual-reissue') {
    const r = orders.manualReissue(db, { terminalId: body.terminalId, faultId: body.faultId, operator: body.operator });
    return { ok: true, ...r };
  }

  // 复核队列
  if (resource === 'review') {
    if (id === 'queue') return { queue: faults.listReview(db, q) };
    if (action === 'settle') return { ok: true, item: faults.settleReview(db, id, body.status, body.handler, body.note) };
    return { queue: faults.listReview(db, q) };
  }

  // 退款
  if (resource === 'refunds') {
    if (!id) return { refunds: refunds.listRefunds(db, q) };
    if (action === 'evidence') return refunds.refundEvidence(db, id);
    if (action === 'decide') return { ok: true, refund: refunds.decideRefund(db, { id, action: body.decision, reviewer: body.reviewer }) };
    if (action === 'timeout') return { ok: true, refund: refunds.timeoutRefund(db, id) };
    return { refund: refunds.getRefund(db, id) };
  }
  if (resource === 'refund-request') {
    const r = refunds.requestRefund(db, { orderId: body.orderId, reason: body.reason, reviewer: body.reviewer, source: body.source });
    return { ok: true, refund: r };
  }

  // 补给路线
  if (resource === 'routes') {
    if (!id) {
      if (Object.keys(body).length) return { ok: true, route: routes.createRoute(db, body) };
      return { routes: routes.listRoutes(db) };
    }
    return { route: routes.getRoute(db, id) };
  }
  if (resource === 'tasks') {
    if (!id) return { tasks: routes.listTasks(db, q) };
    if (action === 'claim') return { ok: true, ...routes.claimTask(db, id, body.operator) };
    if (action === 'enroute') return { ok: true, task: routes.enroute(db, id, body.operator) };
    if (action === 'scan') return { ok: true, ...routes.scanOpen(db, id, { operator: body.operator, code: body.code }) };
    if (action === 'complete') return { ok: true, ...routes.completeRefill(db, id, body) };
    return { task: routes.getTask(db, id) };
  }

  // 离线与补传
  if (resource === 'offline') {
    if (action === 'mark') {
      return body.online === false
        ? { ok: true, terminal: offlineSvc.markOffline(db, id, body.note) }
        : { ok: true, terminal: offlineSvc.markOnline(db, id) };
    }
    if (action === 'sync') {
      return { ok: true, ...offlineSvc.syncEvent(db, id, body) };
    }
    return { events: offlineSvc.listEvents(db, id) };
  }

  const e = new Error('unknown api: ' + '/' + seg.join('/')); e.statusCode = 404; throw e;
}

function overview(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    terminals: {
      total: one('SELECT COUNT(*) c FROM terminals').c,
      online: one('SELECT COUNT(*) c FROM terminals WHERE online=1').c,
      stopped: one('SELECT COUNT(*) c FROM terminals WHERE enabled=0').c,
      lowPaper: one('SELECT COUNT(*) c FROM terminals WHERE paper_remaining < 100').c
    },
    rolls: {
      inStock: one("SELECT COUNT(*) c FROM paper_rolls WHERE status='in_stock'").c,
      installed: one("SELECT COUNT(*) c FROM paper_rolls WHERE status='installed'").c
    },
    orders: {
      issued: one("SELECT COUNT(*) c FROM orders WHERE status='issued'").c,
      failed: one("SELECT COUNT(*) c FROM orders WHERE status='ticket_failed'").c,
      refunded: one("SELECT COUNT(*) c FROM orders WHERE status='refunded'").c,
      amountFen: one('SELECT COALESCE(SUM(amount),0) c FROM orders WHERE pay_ref IS NOT NULL').c
    },
    faults: {
      open: one("SELECT COUNT(*) c FROM fault_tickets WHERE status IN ('open','in_repair')").c
    },
    review: {
      pending: one("SELECT COUNT(*) c FROM review_queue WHERE status='pending'").c
    },
    tasks: {
      active: one("SELECT COUNT(*) c FROM refill_tasks WHERE status IN ('claimed','enroute','cabinet_open')").c
    },
    refundsPending: one("SELECT COUNT(*) c FROM refunds WHERE status IN ('requested','timeout')").c
  };
}

function start(db) {
  const server = createServer(db);
  server.listen(PORT, HOST, () => {
    console.log(`票务自助机平台已启动: http://${HOST}:${PORT}`);
  });
  return server;
}

module.exports = { createServer, start };

if (require.main === module) {
  const { openDb } = require('./db');
  const { seed } = require('./seed');
  const db = openDb();
  const flags = process.argv.slice(2);
  const run = async () => {
    if (flags.includes('--demo')) {
      const r = await seed(db);
      if (r.skipped) console.log('数据库已有数据，跳过演示种子（删除 data/platform.db 可重建）。');
      else console.log('演示数据已创建：正常出票 / 卡纸未出票 / 断纸 / 离线补传 / 重复出票 / 退款（成功·超时·待批）/ 纸卷倒装。');
    }
    start(db);
  };
  run();
}
