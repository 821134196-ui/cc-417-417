'use strict';

function ts(d = new Date()) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 单调-ish 的本地短编号（时间+随机），用于支付流水
function payRef() {
  return 'PAY' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function money(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonOrNull(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { ts, uid, payRef, money, clamp, sleep, jsonOrNull };
