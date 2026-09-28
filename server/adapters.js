'use strict';
// 进程内模拟适配器：支付网关 + 打印机/纸机硬件。
// 不连接任何外部服务，延迟与故障均在进程内模拟。
const { ts, payRef } = require('./util');

class PaymentAdapter {
  constructor() {
    this.latencyMs = 40;
    this.forceFail = false; // 测试用：强制扣款失败
  }

  // 幂等扣款：同一 idempotencyKey 只成功一次
  async charge(db, { orderId, amountFen, idempotencyKey }) {
    await new Promise((r) => setTimeout(r, this.latencyMs));
    const existing = db.prepare('SELECT * FROM payments WHERE idemp_key=?').get(idempotencyKey);
    if (existing) {
      return { ok: existing.status === 'success', ref: existing.ref, amount: existing.amount, duplicated: true };
    }
    const ref = payRef();
    const status = this.forceFail ? 'failed' : 'success';
    db.prepare(`INSERT INTO payments(id, order_id, ref, amount, status, idemp_key, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('PAY_' + Math.random().toString(36).slice(2, 10), orderId, ref, amountFen, status, idempotencyKey, ts());
    return { ok: status === 'success', ref, amount: amountFen, duplicated: false };
  }
}

class PrinterAdapter {
  constructor() {
    this.jamTerminal = null;   // 模拟卡纸终端
    this.offline = new Set();  // 模拟离线终端
  }

  isOnline(terminalId) {
    return !this.offline.has(terminalId);
  }

  setOffline(terminalId, yes) {
    yes ? this.offline.add(terminalId) : this.offline.delete(terminalId);
  }

  // 物理出票：返回 {ok, reason?}。卡纸/离线时硬件层直接失败。
  async print(terminalId, ticketCode) {
    await new Promise((r) => setTimeout(r, 15));
    if (this.offline.has(terminalId)) return { ok: false, reason: 'offline' };
    if (this.jamTerminal === terminalId) return { ok: false, reason: 'paper_jam' };
    return { ok: true };
  }
}

const payment = new PaymentAdapter();
const printer = new PrinterAdapter();

module.exports = { payment, printer, PaymentAdapter, PrinterAdapter };
