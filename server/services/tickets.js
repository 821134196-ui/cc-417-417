'use strict';
// 票据号段：连续分配，绝不跳号。号段用尽即关闭并停用终端。
const { ts, uid } = require('../util');

function ticketCode(prefix, no) {
  return `${prefix}-${String(no).padStart(6, '0')}`;
}

function assignRange(db, terminalId, { prefix, startNo, endNo }) {
  if (endNo < startNo) throw new Error('号段起止非法');
  const active = db.prepare("SELECT id FROM ticket_ranges WHERE terminal_id=? AND status='active'").get(terminalId);
  if (active) {
    const e = new Error('该终端仍有未用完的 active 号段'); e.code = 'E_RANGE_ACTIVE'; throw e;
  }
  const id = uid('TR');
  db.prepare(`INSERT INTO ticket_ranges(id, terminal_id, prefix, start_no, end_no, next_no, status, created_at)
              VALUES (?,?,?,?,?,?,'active',?)`)
    .run(id, terminalId, prefix, startNo, endNo, startNo, ts());
  return getRange(db, id);
}

function getRange(db, id) {
  return db.prepare('SELECT * FROM ticket_ranges WHERE id=?').get(id);
}

function activeRange(db, terminalId) {
  return db.prepare("SELECT * FROM ticket_ranges WHERE terminal_id=? AND status='active'").get(terminalId);
}

class AllocateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 在一个即时事务里原子地分配一个票据号并扣减一张纸。
// node:sqlite 全部同步，事务内无 await，串行化天然成立。
function allocateTicket(db, terminalId, { orderId = null, issueType = 'sale' } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const t = db.prepare('SELECT * FROM terminals WHERE id=?').get(terminalId);
    if (!t) throw new AllocateError('E_TERMINAL_MISSING', '终端不存在');
    if (!t.enabled) throw new AllocateError('E_TERMINAL_STOPPED', '终端已停用（断纸/卡纸/号段用尽），禁止发票');
    if (t.paper_remaining <= 0) throw new AllocateError('E_NO_PAPER', '纸卷已用完');

    const range = activeRange(db, terminalId);
    if (!range) throw new AllocateError('E_RANGE_NONE', '终端没有可用号段');
    if (range.next_no > range.end_no) throw new AllocateError('E_RANGE_EXHAUSTED', '号段已用尽');

    const no = range.next_no;
    const code = ticketCode(range.prefix, no);

    // 条件更新保证号段不超发
    const r1 = db.prepare('UPDATE ticket_ranges SET next_no=? WHERE id=? AND next_no=? AND next_no<=end_no')
      .run(no + 1, range.id, no);
    if (r1.changes !== 1) throw new AllocateError('E_RANGE_EXHAUSTED', '号段已用尽');

    // 条件扣减保证纸张不为负（并发扣减安全）
    const r2 = db.prepare('UPDATE terminals SET paper_remaining=paper_remaining-1 WHERE id=? AND paper_remaining>0')
      .run(terminalId);
    if (r2.changes !== 1) throw new AllocateError('E_NO_PAPER', '纸卷已用完');

    const id = uid('TK');
    db.prepare(`INSERT INTO tickets(id, terminal_id, range_id, ticket_no, ticket_code, order_id, issue_type, status, issued_at)
                VALUES (?,?,?,?,?,?,?, 'printed', ?)`)
      .run(id, terminalId, range.id, no, code, orderId, issueType, ts());
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 号段连续性核验：每个号段内票据号必须恰好覆盖 [start, next)，无缺号、无重号。
function verifyContinuity(db, terminalId) {
  const ranges = db.prepare('SELECT * FROM ticket_ranges WHERE terminal_id=? ORDER BY start_no').all(terminalId);
  const problems = [];
  for (const r of ranges) {
    const rows = db.prepare('SELECT ticket_no, status FROM tickets WHERE range_id=? ORDER BY ticket_no').all(r.id);
    const seen = new Set();
    const expected = new Set();
    for (let n = r.start_no; n < r.next_no; n++) expected.add(n);
    for (const row of rows) {
      if (seen.has(row.ticket_no)) problems.push(`${r.prefix}: 重号 ${row.ticket_no}`);
      seen.add(row.ticket_no);
    }
    for (const n of expected) if (!seen.has(n)) problems.push(`${r.prefix}: 缺号 ${n}`);
    for (const n of seen) if (!expected.has(n)) problems.push(`${r.prefix}: 越界号 ${n}`);
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { assignRange, getRange, activeRange, allocateTicket, verifyContinuity, ticketCode, AllocateError };
