'use strict';
// 终端与纸卷库存
const { ts, uid } = require('../util');

function listTerminals(db) {
  return db.prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM ticket_ranges tr WHERE tr.terminal_id=t.id AND tr.status='active') AS has_active_range,
      (SELECT tr.next_no FROM ticket_ranges tr WHERE tr.terminal_id=t.id AND tr.status='active') AS next_no,
      (SELECT tr.end_no  FROM ticket_ranges tr WHERE tr.terminal_id=t.id AND tr.status='active') AS end_no,
      (SELECT tr.prefix FROM ticket_ranges tr WHERE tr.terminal_id=t.id AND tr.status='active') AS prefix
    FROM terminals t ORDER BY t.id`).all();
}

function getTerminal(db, id) {
  return db.prepare('SELECT * FROM terminals WHERE id=?').get(id);
}

function setOnline(db, id, online) {
  db.prepare('UPDATE terminals SET online=? WHERE id=?').run(online ? 1 : 0, id);
  return getTerminal(db, id);
}

function stopTerminal(db, id) {
  db.prepare('UPDATE terminals SET enabled=0 WHERE id=?').run(id);
}
function resumeTerminal(db, id) {
  db.prepare('UPDATE terminals SET enabled=1 WHERE id=?').run(id);
}

function listRolls(db) {
  return db.prepare('SELECT * FROM paper_rolls ORDER BY id DESC').all();
}

function getRoll(db, id) {
  return db.prepare('SELECT * FROM paper_rolls WHERE id=?').get(id);
}

function createRoll(db, { batchNo, capacity }) {
  const id = uid('R');
  db.prepare(`INSERT INTO paper_rolls(id, batch_no, capacity, status, created_at)
              VALUES (?,?,?, 'in_stock', ?)`).run(id, batchNo, capacity, ts());
  return getRoll(db, id);
}

// 纸卷装入终端（补给完成时调用）
function installRoll(db, terminalId, rollId) {
  const roll = getRoll(db, rollId);
  if (!roll) { const e = new Error('纸卷不存在'); e.code = 'E_ROLL_MISSING'; throw e; }
  if (roll.status !== 'in_stock') { const e = new Error('纸卷不可用（非在库状态）'); e.code = 'E_ROLL_TAKEN'; throw e; }

  db.exec('BEGIN IMMEDIATE');
  try {
    // 旧卷若还挂在终端上，标记用完
    const t = db.prepare('SELECT * FROM terminals WHERE id=?').get(terminalId);
    if (t.roll_id) {
      db.prepare("UPDATE paper_rolls SET status='used', used_up_at=? WHERE id=?")
        .run(ts(), t.roll_id);
    }
    db.prepare(`UPDATE paper_rolls SET status='installed', terminal_id=?, installed_at=? WHERE id=?`)
      .run(terminalId, ts(), rollId);
    db.prepare(`UPDATE terminals
                SET roll_id=?, paper_remaining=(SELECT capacity FROM paper_rolls WHERE id=?), last_refill_at=?
                WHERE id=?`)
      .run(rollId, rollId, ts(), terminalId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getRoll(db, rollId);
}

// 库存统计
function inventory(db) {
  const rows = db.prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(capacity),0) cap FROM paper_rolls GROUP BY status`).all();
  return rows;
}

module.exports = {
  listTerminals, getTerminal, setOnline, stopTerminal, resumeTerminal,
  listRolls, getRoll, createRoll, installRoll, inventory
};
