'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.TKP_DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.TKP_DB_PATH || path.join(DATA_DIR, 'platform.db');
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.TKP_PORT || 8080);
const HOST = process.env.TKP_HOST || '127.0.0.1';

module.exports = { ROOT, DATA_DIR, DB_PATH, RECEIPT_DIR, PUBLIC_DIR, PORT, HOST };
