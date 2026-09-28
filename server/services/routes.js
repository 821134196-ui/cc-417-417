'use strict';
// 补给路线与任务：任务锁定（两人抢一单只保留一个）、扫码开柜、
// 计数器前后照片、装卷/纸卷倒装上报、换卷后恢复发票。
const crypto = require('crypto');
const { ts, uid } = require('../util');
const terms = require('./terminals');
const faults = require('./faults');
const receipts = require('../receipts');

function createRoute(db, { name, terminalIds = [] }) {
  const id = uid('RT');
  db.prepare('INSERT INTO refill_routes(id, name, created_at) VALUES (?,?,?)').run(id, name, ts());
  terminalIds.forEach((tid, i) => {
    db.prepare(`INSERT INTO refill_tasks(id, route_id, terminal_id, seq, status, created_at)
                VALUES (?,?,?,?, 'queued', ?)`).run(uid('TSK'), id, tid, i + 1, ts());
  });
  return getRoute(db, id);
}

function listRoutes(db) {
  return db.prepare('SELECT * FROM refill_routes ORDER BY created_at DESC').all();
}

function getRoute(db, id) {
  const route = db.prepare('SELECT * FROM refill_routes WHERE id=?').get(id);
  if (!route) return null;
  const tasks = db.prepare(`SELECT k.*, t.name terminal_name, t.location, t.paper_remaining,
        t.paper_capacity, t.enabled, t.online
      FROM refill_tasks k JOIN terminals t ON t.id=k.terminal_id
      WHERE k.route_id=? ORDER BY k.seq`).all(id);
  return { ...route, tasks };
}

function listTasks(db, { status } = {}) {
  let sql = `SELECT k.*, t.name terminal_name, t.location FROM refill_tasks k
             JOIN terminals t ON t.id=k.terminal_id WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND k.status=?'; args.push(status); }
  sql += ' ORDER BY k.created_at DESC, k.seq';
  return db.prepare(sql).all(...args);
}

function getTask(db, id) {
  return db.prepare('SELECT * FROM refill_tasks WHERE id=?').get(id);
}

// 领取任务：条件 UPDATE 保证只有一个锁定者。
// 返回 {ok, task, reason}；第二个领取者 ok=false。
function claimTask(db, taskId, operator) {
  const scanCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const r = db.prepare(`UPDATE refill_tasks
      SET status='claimed', locked_by=?, locked_at=?, scan_code=COALESCE(scan_code,?)
      WHERE id=? AND status='queued' AND locked_by IS NULL`)
    .run(operator, ts(), scanCode, taskId);
  const task = getTask(db, taskId);
  if (r.changes === 1) return { ok: true, task };
  if (!task) return { ok: false, reason: '任务不存在' };
  return { ok: false, reason: `任务已被 ${task.locked_by || '其他补给员'} 锁定`, task };
}

// 扫码开柜：必须先锁定任务，扫码口令匹配才开柜，并记录换卷前计数器照片
function scanOpen(db, taskId, { operator, code }) {
  const task = getTask(db, taskId);
  if (!task) { const e = new Error('任务不存在'); e.code = 'E_TASK'; throw e; }
  if (task.locked_by !== operator) {
    const e = new Error('只有任务锁定者才能扫码开柜'); e.code = 'E_LOCK'; throw e;
  }
  if (!['claimed', 'enroute'].includes(task.status)) {
    const e = new Error('当前任务状态不可扫码开柜'); e.code = 'E_STATE'; throw e;
  }
  const scanCode = task.scan_code;
  if (!scanCode) { const e = new Error('任务缺少柜门口令'); e.code = 'E_SCAN'; throw e; }
  if (code !== scanCode) { const e = new Error('扫码口令不正确，柜门未开'); e.code = 'E_SCAN'; throw e; }

  const termRow = terms.getTerminal(db, task.terminal_id);
  const beforeCount = termRow.paper_remaining;
  const file = receipts.writeCounterPhoto(task.terminal_id, 'before', beforeCount, { note: 'pre-refill' });
  receipts.registerReceipt(db, task.terminal_id, 'counter_before', file, 'task', taskId);
  receipts.writeCabinetReceipt(task.terminal_id, scanCode, operator);

  db.prepare(`UPDATE refill_tasks SET status='cabinet_open', scanned_at=?, before_photo=?, before_count=? WHERE id=?`)
    .run(ts(), file, beforeCount, taskId);
  return { ok: true, task: getTask(db, taskId), scanCode, beforeCount, beforePhoto: file };
}

// 完成换卷：记录换卷后计数器照片，装入新纸卷。
// reversed=true 表示纸卷倒装：不开机发票，转复核队列。
function completeRefill(db, taskId, { operator, rollId, reversed = false, note = '' }) {
  const task = getTask(db, taskId);
  if (!task) { const e = new Error('任务不存在'); e.code = 'E_TASK'; throw e; }
  if (task.locked_by !== operator) { const e = new Error('只有锁定者能完成换卷'); e.code = 'E_LOCK'; throw e; }
  if (task.status !== 'cabinet_open') { const e = new Error('请先扫码开柜'); e.code = 'E_STATE'; throw e; }

  if (reversed) {
    const file = receipts.writeCounterPhoto(task.terminal_id, 'after', 0, { roll: rollId, note: 'ROLL REVERSED' });
    receipts.registerReceipt(db, task.terminal_id, 'counter_after', file, 'task', taskId);
    const fault = faults.openFault(db, {
      terminalId: task.terminal_id, kind: 'roll_reversed', severity: 'high',
      summary: `补给员 ${operator} 上报纸卷倒装，禁止发票`, orderId: null
    });
    faults.enqueueReview(db, {
      category: 'roll_reversed', terminalId: task.terminal_id, faultId: fault.id,
      note: note || '纸卷方向装反，需重新装卷'
    });
    db.prepare(`UPDATE refill_tasks SET status='skipped', after_photo=?, after_count=0, roll_id=?, completed_at=? WHERE id=?`)
      .run(file, rollId || null, ts(), taskId);
    terms.stopTerminal(db, task.terminal_id);
    return { ok: false, reversed: true, task: getTask(db, taskId), fault };
  }

  if (!rollId) { const e = new Error('必须指定装入的纸卷批次'); e.code = 'E_ROLL'; throw e; }
  terms.installRoll(db, task.terminal_id, rollId);
  const t = terms.getTerminal(db, task.terminal_id);
  const file = receipts.writeCounterPhoto(task.terminal_id, 'after', t.paper_remaining, { roll: rollId, note: 'post-refill' });
  receipts.registerReceipt(db, task.terminal_id, 'counter_after', file, 'task', taskId);

  // 恢复发票：卡纸/断纸排除后，若号段仍有余量则重新启用终端
  const { activeRange } = require('./tickets');
  const range = activeRange(db, task.terminal_id);
  if (range && range.next_no <= range.end_no) terms.resumeTerminal(db, task.terminal_id);

  db.prepare(`UPDATE refill_tasks SET status='done', after_photo=?, after_count=?, roll_id=?, completed_at=? WHERE id=?`)
    .run(file, t.paper_remaining, rollId, ts(), taskId);
  return { ok: true, task: getTask(db, taskId), afterCount: t.paper_remaining, afterPhoto: file };
}

function enroute(db, taskId, operator) {
  const task = getTask(db, taskId);
  if (!task || task.locked_by !== operator) { const e = new Error('非任务锁定者'); e.code = 'E_LOCK'; throw e; }
  db.prepare("UPDATE refill_tasks SET status='enroute' WHERE id=? AND status='claimed'").run(taskId);
  return getTask(db, taskId);
}

module.exports = {
  createRoute, listRoutes, getRoute, listTasks, getTask,
  claimTask, enroute, scanOpen, completeRefill
};
