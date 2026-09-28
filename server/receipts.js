'use strict';
// 设备回执本地文件存储：柜锁记录、计数器照片（SVG 模拟实拍）、打印小票等
const fs = require('fs');
const path = require('path');
const { RECEIPT_DIR, ROOT } = require('./config');
const { ts, uid } = require('./util');

function rel(file) {
  if (!path.isAbsolute(file)) return file.replace(/\\/g, '/');
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function receiptPath(kind, terminalId, name) {
  const dir = ensureDir(path.join(RECEIPT_DIR, terminalId, kind));
  const file = path.join(dir, name);
  return { dir, file };
}

// 计数器照片：用 SVG 模拟终端计数器实拍画面
function writeCounterPhoto(terminalId, kind /* before|after */, count, meta = {}) {
  ensureDir(RECEIPT_DIR);
  const stamp = ts().replace(/[: ]/g, '-');
  const name = `counter_${kind}_${stamp}_${Math.random().toString(36).slice(2, 6)}.svg`;
  const { file } = receiptPath('counter', terminalId, name);
  const color = kind === 'before' ? '#f59e0b' : '#16a34a';
  const label = kind === 'before' ? '换卷前 BEFORE' : '换卷后 AFTER';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300" font-family="monospace">
  <rect width="480" height="300" fill="#1e1b4b"/>
  <rect x="20" y="20" width="440" height="260" rx="12" fill="#312e81" stroke="${color}" stroke-width="3"/>
  <text x="240" y="60" text-anchor="middle" fill="#fde047" font-size="22" font-weight="bold">${terminalId} · ${label}</text>
  <rect x="70" y="90" width="340" height="90" rx="8" fill="#0f172a"/>
  <text x="240" y="150" text-anchor="middle" fill="${color}" font-size="56" font-weight="bold">${String(count).padStart(6, '0')}</text>
  <text x="240" y="210" text-anchor="middle" fill="#c7d2fe" font-size="15">COUNTER · ${ts()}</text>
  <text x="240" y="240" text-anchor="middle" fill="#94a3b8" font-size="13">${meta.roll ? 'ROLL ' + meta.roll : ''} ${meta.note || ''}</text>
  <text x="240" y="266" text-anchor="middle" fill="#64748b" font-size="11">simulated device camera capture</text>
</svg>`;
  fs.writeFileSync(file, svg, 'utf8');
  return path.relative(path.join(RECEIPT_DIR, '..', '..'), file).replace(/\\/g, '/');
}

// 柜门锁扫码回执
function writeCabinetReceipt(terminalId, scanCode, operator) {
  ensureDir(RECEIPT_DIR);
  const name = `cabinet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`;
  const { file } = receiptPath('cabinet', terminalId, name);
  const body = [
    '===== 设备柜锁回执 DEVICE CABINET RECEIPT =====',
    `终端 Terminal : ${terminalId}`,
    `扫码口令 Code : ${scanCode}`,
    `操作员 Operator: ${operator}`,
    `时间 Time     : ${ts()}`,
    '事件 Event    : SCAN_OK -> LOCK_RELEASED（扫码通过，柜门已开）',
    '==============================================',
    ''
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

// 打印小票回执
function writePrintReceipt(terminalId, ticketCode, orderId, amountYuan) {
  ensureDir(RECEIPT_DIR);
  const name = `print_${ticketCode.replace(/[^A-Za-z0-9]/g, '_')}.txt`;
  const { file } = receiptPath('print', terminalId, name);
  const body = [
    '-------- 票务自助机 KIOSK RECEIPT --------',
    `终端   : ${terminalId}`,
    `票号   : ${ticketCode}`,
    `订单   : ${orderId}`,
    `金额   : ¥${amountYuan.toFixed(2)}`,
    `时间   : ${ts()}`,
    '状态   : PRINTED 已出票',
    '------------------------------------------',
    ''
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

// 故障/离线补传等通用 JSON 回执
function writeJsonReceipt(terminalId, kind, obj) {
  ensureDir(RECEIPT_DIR);
  const name = `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`;
  const { file } = receiptPath(kind, terminalId, name);
  fs.writeFileSync(file, JSON.stringify({ terminalId, at: ts(), ...obj }, null, 2), 'utf8');
  return file;
}

function registerReceipt(db, terminalId, kind, filePath, refType, refId) {
  const id = uid('DR');
  db.prepare(`INSERT INTO device_receipts(id, terminal_id, kind, file_path, ref_type, ref_id, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, terminalId, kind, rel(filePath), refType || null, refId || null, ts());
  return id;
}

// 对外可访问的 URL 路径：/files/data/receipts/...
function toUrl(filePath) {
  const r = path.isAbsolute(filePath) ? rel(filePath) : filePath;
  return '/files/' + r.replace(/^\/+/, '');
}

module.exports = {
  writeCounterPhoto, writeCabinetReceipt, writePrintReceipt,
  writeJsonReceipt, registerReceipt, toUrl, rel
};
