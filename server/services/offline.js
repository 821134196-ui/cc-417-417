'use strict';
// 设备离线与补传：离线期间事件本地缓存，恢复后补传。
// client_event_id 唯一约束去重；同事件重复补传只应用一次。
const { ts, uid } = require('../util');
const terms = require('./terminals');
const tickets = require('./tickets');
const faults = require('./faults');
const receipts = require('../receipts');
const { printer } = require('../adapters');

// 终端离线：标记状态 + 回执 + 复核队列
function markOffline(db, terminalId, note = '设备心跳超时离线') {
  terms.setOnline(db, terminalId, false);
  printer.setOffline(terminalId, true);
  receipts.writeJsonReceipt(terminalId, 'offline_sync', { event: 'offline', note });
  faults.enqueueReview(db, { category: 'offline', terminalId, note });
  return terms.getTerminal(db, terminalId);
}

// 终端恢复在线
function markOnline(db, terminalId) {
  terms.setOnline(db, terminalId, true);
  printer.setOffline(terminalId, false);
  return terms.getTerminal(db, terminalId);
}

// 补传单条事件。返回 {applied, duplicated}
// 支持 kind: heartbeat / counter / ticket_printed
function syncEvent(db, terminalId, { clientEventId, kind, payload = {}, eventTime }) {
  // 去重：重复补传同一 client_event_id 不重复应用
  const existed = db.prepare('SELECT * FROM offline_events WHERE client_event_id=?').get(clientEventId);
  if (existed) {
    return { applied: false, duplicated: true, event: existed };
  }
  const id = uid('OE');
  db.prepare(`INSERT INTO offline_events(id, terminal_id, client_event_id, kind, payload, event_time, received_at, applied)
              VALUES (?,?,?,?,?,?,?,0)`)
    .run(id, terminalId, clientEventId, kind, JSON.stringify(payload), eventTime || ts(), ts());

  let result = {};
  if (kind === 'heartbeat') {
    terms.setOnline(db, terminalId, true);
    printer.setOffline(terminalId, false);
    result.online = true;
  } else if (kind === 'counter') {
    if (typeof payload.paper_remaining === 'number') {
      db.prepare('UPDATE terminals SET paper_remaining=? WHERE id=?').run(payload.paper_remaining, terminalId);
    }
    receipts.writeJsonReceipt(terminalId, 'offline_sync', { event: 'counter', ...payload });
  } else if (kind === 'ticket_printed') {
    // 离线期间已出票的补传：只在连续台账登记，不重打
    result = applyOfflineTicket(db, terminalId, payload, id);
  }

  db.prepare('UPDATE offline_events SET applied=1 WHERE id=?').run(id);
  const event = db.prepare('SELECT * FROM offline_events WHERE id=?').get(id);
  return { applied: true, duplicated: false, event, result };
}

// 离线期间打印的票据补登：若与当前号段期望一致则顺号入账；
// 若本地计数器与服务器号段不一致，进复核而非跳号。
function applyOfflineTicket(db, terminalId, payload, eventId) {
  const range = tickets.activeRange(db, terminalId);
  if (!range) return { accepted: false, reason: 'no_active_range' };

  const code = String(payload.ticket_code || '');
  const m = code.match(/^([A-Za-z]+)-(\d+)$/);
  if (!m || m[1] !== range.prefix) return { accepted: false, reason: 'code_prefix_mismatch' };
  const no = Number(m[2]);

  if (no !== range.next_no) {
    faults.enqueueReview(db, {
      category: 'offline', terminalId,
      note: `离线补传票号 ${code} 与服务器下一号 ${range.prefix}-${range.next_no} 不一致，需人工核验`,
    });
    return { accepted: false, reason: 'seq_mismatch', expected: range.next_no, got: no };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE ticket_ranges SET next_no=? WHERE id=? AND next_no=?')
      .run(no + 1, range.id, no);
    db.prepare('UPDATE terminals SET paper_remaining=MAX(paper_remaining-1,0) WHERE id=?').run(terminalId);
    db.prepare(`INSERT INTO tickets(id, terminal_id, range_id, ticket_no, ticket_code, order_id, issue_type, status, issued_at)
                VALUES (?,?,?,?,?,?, 'sale', 'printed', ?)`)
      .run(uid('TK'), terminalId, range.id, no, code, payload.order_id || null, ts());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  receipts.writeJsonReceipt(terminalId, 'offline_sync', { event: 'ticket_printed', code, eventId });
  return { accepted: true, code };
}

function listEvents(db, terminalId) {
  let sql = 'SELECT * FROM offline_events WHERE 1=1';
  const args = [];
  if (terminalId) { sql += ' AND terminal_id=?'; args.push(terminalId); }
  sql += ' ORDER BY received_at DESC LIMIT 200';
  return db.prepare(sql).all(...args);
}

module.exports = { markOffline, markOnline, syncEvent, listEvents };
