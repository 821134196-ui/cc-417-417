'use strict';
/* ============== 通用工具 ============== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b || {});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = (fen) => '¥' + ((fen || 0) / 100).toFixed(2);
const pct = (a, b) => (b ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

const ORDER_STATUS = {
  created: ['待支付', 'gray'], paid: ['已扣款', 'indigo'], issued: ['已出票', 'green'],
  ticket_failed: ['出票失败', 'red'], refunded: ['已退款', 'amber'], closed: ['已关闭', 'gray']
};
const FAULT_KIND = {
  no_paper: '断纸', paper_jam: '卡纸', range_exhausted: '号段用尽', roll_reversed: '纸卷倒装',
  offline: '设备离线', paid_no_ticket: '扣款未出票', duplicate_ticket: '重复出票'
};
const FAULT_STATUS = { open: ['待处理', 'red'], in_repair: ['维修中', 'amber'], resolved: ['已修复', 'green'], rejected: ['已驳回', 'gray'] };
const REVIEW_CAT = {
  paid_no_ticket: '扣款成功未出票', duplicate_ticket: '重复出票',
  refund_timeout: '退款超时', roll_reversed: '纸卷倒装', offline: '设备离线'
};
const TASK_STATUS = {
  queued: ['待领取', 'gray'], claimed: ['已锁定', 'indigo'], enroute: ['前往中', 'indigo'],
  cabinet_open: ['柜门已开', 'amber'], done: ['补给完成', 'green'], skipped: ['异常中止', 'red']
};
const REFUND_STATUS = {
  requested: ['待审批', 'amber'], approved: ['已批准', 'indigo'], success: ['退款成功', 'green'],
  rejected: ['已驳回', 'gray'], timeout: ['退款超时', 'red']
};
const ROLL_STATUS = { in_stock: ['在库', 'green'], installed: ['装机中', 'indigo'], used: ['已用完', 'gray'] };

function tag(text, cls) { return `<span class="tag ${cls}">${esc(text)}</span>`; }
function statusTag(map, key) { const v = map[key]; return v ? tag(v[0], v[1]) : esc(key); }

function fileUrl(p) { return p ? '/files/' + p.replace(/^\/+/, '') : ''; }

/* ============== 导航与概览 ============== */
let currentView = 'map';
$('#nav').addEventListener('click', async (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
  currentView = btn.dataset.view;
  await render();
});

async function loadOverview() {
  const o = await get('/api/overview');
  $('#kpiStrip').innerHTML = `
    <div class="kpi"><div class="v">${o.terminals.online}/${o.terminals.total}</div><div class="l">在线终端</div></div>
    <div class="kpi warn"><div class="v">${o.terminals.stopped}</div><div class="l">停用（故障/缺纸）</div></div>
    <div class="kpi warn"><div class="v">${o.terminals.lowPaper}</div><div class="l">低纸量（&lt;100）</div></div>
    <div class="kpi"><div class="v">${o.rolls.inStock}</div><div class="l">在库纸卷</div></div>
    <div class="kpi"><div class="v">${yuan(o.orders.amountFen)}</div><div class="l">模拟收款总额</div></div>
    <div class="kpi warn"><div class="v">${o.review.pending}</div><div class="l">待复核事件</div></div>
    <div class="kpi warn"><div class="v">${o.refundsPending}</div><div class="l">待处理退款</div></div>
  `;
  $('#navFault').textContent = o.review.pending || '';
}

async function render() {
  await loadOverview();
  ({
    map: renderMap, rolls: renderRolls, routes: renderRoutes,
    faults: renderFaults, orders: renderOrders, refunds: renderRefunds
  })[currentView]();
}

/* ============== 视图 1：终端地图与矩阵 ============== */
async function renderMap() {
  const { terminals } = await get('/api/terminals');
  const pins = terminals.map((t) => {
    const cls = [!t.enabled ? 'stop' : '', t.paper_remaining < 100 ? 'low' : '', !t.online ? 'offline' : ''].join(' ');
    return `<div class="map-pin ${cls}" style="left:${t.x}%;top:${t.y}%" data-tid="${t.id}" title="${esc(t.name)}">
      <span class="pulse"></span>
      <span class="pinbody"></span>
      <span class="pinlabel">${t.id} · ${t.paper_remaining}</span>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="card">
      <h2>终端地图 <span class="muted">— 点击图钉或矩阵卡片查看号段、纸量与工单</span></h2>
      <div class="map-wrap"><div class="map-grid"></div>${pins}</div>
      <div class="muted" style="margin-top:8px">
        图钉：<span class="tag indigo">正常</span> <span class="tag amber">低纸量 &lt;100</span>
        <span class="tag red">停用/故障</span> 数字为剩余张数
      </div>
    </div>
    <div class="card">
      <h2>终端矩阵 · 纸量刻度与在线状态</h2>
      <div class="matrix" id="matrix">
        ${terminals.map(termCard).join('')}
      </div>
    </div>`;
  $$('.map-pin, .term-card').forEach((el) => el.addEventListener('click', () => openTerminal(el.dataset.tid)));
}

function termCard(t) {
  const p = pct(t.paper_remaining, t.paper_capacity);
  const fillCls = t.paper_remaining < 60 ? 'crit' : t.paper_remaining < 100 ? 'low' : '';
  const ticks = Array.from({ length: 10 }, () => '<span></span>').join('');
  const rangeText = t.has_active_range
    ? `<span class="mono">${t.prefix}-${String(t.next_no).padStart(6, '0')} → ${t.prefix}-${String(t.end_no).padStart(6, '0')}</span>`
    : '<span style="color:var(--red)">无 active 号段</span>';
  return `<div class="term-card ${!t.enabled ? 'stop' : ''} ${t.paper_remaining < 100 ? 'low' : ''} ${!t.online ? 'offline' : ''}" data-tid="${t.id}">
    <div class="term-head">
      <span class="term-id">${t.id}</span>
      <span>${t.online ? '<span class="dot on"></span> <span class="muted">在线</span>' : '<span class="dot off"></span> <span class="muted" style="color:var(--red)">离线</span>'}</span>
    </div>
    <div class="term-name">${esc(t.name)}<br><span class="muted">${esc(t.location)}</span></div>
    <div class="gauge">
      <div class="gauge-track"><div class="gauge-fill ${fillCls}" style="width:${p}%"></div></div>
      <div class="gauge-ticks">${ticks}</div>
      <div class="gauge-meta"><span>${t.paper_remaining} 张</span><span>满卷 ${t.paper_capacity}</span></div>
    </div>
    <div class="range-line">号段 ${rangeText}</div>
    <div style="margin-top:8px">
      ${t.enabled ? tag('允许发票', 'green') : tag('停止发票', 'red')}
    </div>
  </div>`;
}

async function openTerminal(tid) {
  const [{ terminal }, { orders }] = await Promise.all([
    get('/api/terminals/' + tid),
    get('/api/orders?terminalId=' + tid)
  ]);
  const cont = await get('/api/terminals/' + tid + '/continuity');
  const faultRows = (await get('/api/faults')).faults.filter((f) => f.terminal_id === tid);
  drawer(`终端 ${tid}`, `
    <div class="kv" style="margin-bottom:10px">
      <dt>名称位置</dt><dd>${esc(terminal.name)} · ${esc(terminal.location)}</dd>
      <dt>在线状态</dt><dd>${terminal.online ? tag('在线', 'green') : tag('离线', 'red')}</dd>
      <dt>发票状态</dt><dd>${terminal.enabled ? tag('允许发票', 'green') : tag('停止发票', 'red')}</dd>
      <dt>纸卷余量</dt><dd class="mono">${terminal.paper_remaining} / ${terminal.paper_capacity}（末次补给 ${terminal.last_refill_at || '—'}）</dd>
      <dt>号段连续性</dt><dd>${cont.ok ? tag('校验通过：无缺号/重号', 'green') : '<span class="tag red">异常</span> ' + esc(cont.problems.join('；'))}</dd>
    </div>
    <div class="row" style="margin:10px 0">
      <button class="act ghost mini" onclick="tvOnline('${tid}', true)">设为在线</button>
      <button class="act ghost mini" onclick="tvOnline('${tid}', false)">模拟离线</button>
      <button class="act yellow mini" onclick="tvResume('${tid}')">恢复发票</button>
      <button class="act danger mini" onclick="tvStop('${tid}')">停止发票</button>
    </div>
    <h3>相关故障工单</h3>
    ${faultRows.length ? `<table><tr><th>类型</th><th>状态</th><th>说明</th></tr>
      ${faultRows.map((f) => `<tr><td>${tag(FAULT_KIND[f.kind] || f.kind, f.severity === 'high' ? 'red' : 'amber')}</td>
        <td>${statusTag(FAULT_STATUS, f.status)}</td><td>${esc(f.summary)}</td></tr>`).join('')}</table>`
      : '<div class="empty">暂无工单</div>'}
    <h3>最近订单</h3>
    ${orders.length ? `<table><tr><th>订单</th><th>票品</th><th>金额</th><th>状态</th></tr>
      ${orders.slice(0, 8).map((o) => `<tr style="cursor:pointer" onclick="openOrder('${o.id}')">
        <td class="mono">${o.id.slice(-8)}</td><td>${esc(o.item)}</td><td class="pill-amount">${yuan(o.amount)}</td>
        <td>${statusTag(ORDER_STATUS, o.status)}</td></tr>`).join('')}</table>`
      : '<div class="empty">暂无订单</div>'}
  `);
}

window.tvOnline = async (tid, on) => { await post(`/api/terminals/${tid}/online`, { online: on }); toast(on ? '已设为在线（含补传心跳）' : '已模拟离线', 'ok'); closeDrawer(); render(); };
window.tvResume = async (tid) => { await post(`/api/terminals/${tid}/resume`, {}); toast('已恢复发票', 'ok'); closeDrawer(); render(); };
window.tvStop = async (tid) => { await post(`/api/terminals/${tid}/stop`, {}); toast('已停止发票', 'ok'); closeDrawer(); render(); };

/* ============== 视图 2：纸卷库存 ============== */
async function renderRolls() {
  const { rolls, inventory } = await get('/api/rolls');
  const inv = Object.fromEntries(inventory.map((r) => [r.status, r]));
  view.innerHTML = `
    <div class="card">
      <h2>纸卷批次库存</h2>
      <div class="toolbar">
        <div class="kpi" style="min-width:130px"><div class="v">${inv.in_stock?.c || 0}</div><div class="l">在库批次</div></div>
        <div class="kpi" style="min-width:130px"><div class="v">${inv.installed?.c || 0}</div><div class="l">装机中</div></div>
        <div class="kpi" style="min-width:130px"><div class="v">${inv.used?.c || 0}</div><div class="l">已用完</div></div>
      </div>
      <form class="row" id="newRoll" style="margin-bottom:14px">
        <label class="fl">批次号<input name="batchNo" placeholder="B2026-09xx" required></label>
        <label class="fl">额定张数<input name="capacity" type="number" value="1000" min="100" step="100" required></label>
        <button class="act yellow">入库新纸卷</button>
      </form>
      <table>
        <tr><th>批次号</th><th>额定张数</th><th>状态</th><th>装机终端</th><th>装机时间</th><th>用完时间</th></tr>
        ${rolls.map((r) => `<tr>
          <td class="mono">${esc(r.batch_no)}</td><td>${r.capacity}</td>
          <td>${statusTag(ROLL_STATUS, r.status)}</td>
          <td>${r.terminal_id || '—'}</td><td class="mono">${r.installed_at || '—'}</td>
          <td class="mono">${r.used_up_at || '—'}</td></tr>`).join('')}
      </table>
    </div>`;
  $('#newRoll').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await post('/api/rolls', { batchNo: f.get('batchNo'), capacity: Number(f.get('capacity')) });
      toast('纸卷已入库', 'ok'); render();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ============== 视图 3：补给路线 ============== */
async function renderRoutes() {
  const { routes: list } = await get('/api/routes');
  const { rolls } = await get('/api/rolls');
  const inStock = rolls.filter((r) => r.status === 'in_stock');
  view.innerHTML = `
    <div class="card">
      <h2>补给路线</h2>
      <p class="section-note">规则：补给员扫码后才能开柜；换卷前后留存计数器照片；纸卷倒装/断纸/卡纸必须停止发票，不能跳号继续打印；两名补给员同时领取同一任务只保留一个锁定者。</p>
      <form class="row" id="newRoute" style="margin-bottom:12px">
        <label class="fl">路线名称<input name="name" placeholder="如：9 月 30 日 · 城东线" required style="width:240px"></label>
        <button class="act yellow">按全部低纸量/停用终端生成路线</button>
      </form>
      <div id="routeList">${list.map((r) => routeBlock(r, inStock)).join('') || '<div class="empty">暂无路线</div>'}</div>
    </div>`;

  $('#newRoute').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { terminals } = await get('/api/terminals');
    const ids = terminals.filter((t) => t.paper_remaining < 100 || !t.enabled).map((t) => t.id);
    if (!ids.length) return toast('当前没有需要补给的终端');
    const f = new FormData(e.target);
    await post('/api/routes', { name: f.get('name'), terminalIds: ids });
    toast('路线已生成', 'ok'); render();
  });
}

function routeBlock(r, inStock) {
  return `<div class="card" style="background:var(--gray-50)">
    <div class="flex-between">
      <h2 style="margin:0">${esc(r.name)} <span class="muted mono">${r.id.slice(-6)}</span></h2>
      <span class="muted">${r.tasks.length} 个任务 · 创建于 ${r.created_at}</span>
    </div>
    <table style="margin-top:10px">
      <tr><th>#</th><th>终端</th><th>位置</th><th>余量</th><th>状态</th><th>锁定者</th><th>操作</th></tr>
      ${r.tasks.map((k) => {
        const st = TASK_STATUS[k.status] || [k.status, 'gray'];
        return `<tr>
          <td>${k.seq}</td><td class="mono">${k.terminal_id}</td><td>${esc(k.location)}</td>
          <td class="mono">${k.paper_remaining}</td>
          <td>${tag(st[0], st[1])}</td><td>${k.locked_by ? esc(k.locked_by) : '—'}</td>
          <td style="white-space:nowrap">${taskActions(k, inStock)}</td>
        </tr>`;
      }).join('')}
    </table>
    ${r.tasks.some((k) => k.before_photo || k.after_photo) ? `<h3>计数器照片</h3><div class="photo-pair" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">
      ${r.tasks.flatMap((k) => [
        k.before_photo ? photoBox(k.before_photo, `${k.terminal_id} 换卷前`, k.before_count) : '',
        k.after_photo ? photoBox(k.after_photo, `${k.terminal_id} 换卷后`, k.after_count) : ''
      ].join('')).join('')}
    </div>` : ''}
  </div>`;
}

function photoBox(p, cap, count) {
  return `<div class="photo-box"><img src="${fileUrl(p)}" alt="${esc(cap)}">
    <div class="photo-cap"><span>${esc(cap)}</span><span class="mono">${count ?? ''}</span></div></div>`;
}

function taskActions(k, inStock) {
  const opts = inStock.map((r) => `<option value="${r.id}">${esc(r.batch_no)}（${r.capacity}张）</option>`).join('');
  if (k.status === 'queued') {
    return `<input placeholder="补给员姓名" style="width:110px" id="op-${k.id}">
      <button class="act mini" onclick="claim('${k.id}')">领取锁定</button>`;
  }
  if (k.status === 'claimed' || k.status === 'enroute') {
    return `<span class="muted">扫码口令：<span class="scan-code">${esc(k.scan_code)}</span></span>
      <input placeholder="扫码口令" style="width:110px" id="code-${k.id}" value="${esc(k.scan_code)}">
      <input type="hidden" id="opc-${k.id}" value="${esc(k.locked_by)}">
      <button class="act yellow mini" onclick="scan('${k.id}')">扫码开柜</button>`;
  }
  if (k.status === 'cabinet_open') {
    return `<select id="roll-${k.id}">${opts}</select>
      <input type="hidden" id="opr-${k.id}" value="${esc(k.locked_by)}">
      <button class="act mini" onclick="complete('${k.id}', false)">换卷完成</button>
      <button class="act danger mini" onclick="complete('${k.id}', true)">纸卷倒装上报</button>`;
  }
  return `<button class="act ghost mini" onclick="showTask('${k.id}')">详情</button>`;
}

window.claim = async (id) => {
  const op = $('#op-' + id).value.trim() || '补给员-匿名';
  const r = await post(`/api/tasks/${id}/claim`, { operator: op });
  toast(r.ok ? `${op} 已锁定任务，柜门扫码口令 ${r.task.scan_code}` : r.reason, r.ok ? 'ok' : 'err');
  render();
};
window.scan = async (id) => {
  const op = $('#opc-' + id).value;
  const code = $('#code-' + id).value.trim();
  try {
    const r = await post(`/api/tasks/${id}/scan`, { operator: op, code });
    toast(`扫码通过，柜门已开 · 换卷前计数 ${r.beforeCount}`, 'ok'); render();
  } catch (e) { toast(e.message, 'err'); }
};
window.complete = async (id, reversed) => {
  const op = $('#opr-' + id).value;
  const rollSel = $('#roll-' + id);
  const rollId = rollSel ? rollSel.value : null;
  try {
    const r = await post(`/api/tasks/${id}/complete`, { operator: op, rollId, reversed });
    if (reversed) toast('已上报纸卷倒装：终端保持停用，事件进入复核队列', 'err');
    else toast(`换卷完成：计数 ${r.afterCount}，已恢复发票`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
};
window.showTask = async (id) => {
  const { task } = await get('/api/tasks/' + id);
  drawer('任务 ' + task.terminal_id, `<div class="kv">
    <dt>状态</dt><dd>${esc(task.status)}</dd><dt>锁定者</dt><dd>${esc(task.locked_by || '—')}</dd>
    <dt>扫码时间</dt><dd class="mono">${task.scanned_at || '—'}</dd>
    <dt>完成时间</dt><dd class="mono">${task.completed_at || '—'}</dd></div>
    <h3>计数器照片</h3><div class="photo-pair">
      ${task.before_photo ? photoBox(task.before_photo, '换卷前', task.before_count) : ''}
      ${task.after_photo ? photoBox(task.after_photo, '换卷后', task.after_count) : ''}
    </div>`);
};

/* ============== 视图 4：故障与复核队列 ============== */
async function renderFaults() {
  const [{ faults: list }, { queue }] = await Promise.all([
    get('/api/faults'),
    get('/api/review/queue')
  ]);
  const groups = {};
  queue.forEach((q) => { (groups[q.category] = groups[q.category] || []).push(q); });

  view.innerHTML = `
    <div class="card">
      <h2>复核队列 <span class="muted">— 扣款成功未出票 / 重复出票 / 退款超时 / 纸卷倒装 / 设备离线</span></h2>
      <div id="reviewGroups">
        ${Object.keys(REVIEW_CAT).map((cat) => `
          <h3>${REVIEW_CAT[cat]} <span class="tag ${groups[cat]?.length ? 'red' : 'gray'}">${groups[cat]?.length || 0}</span></h3>
          ${groups[cat]?.length ? `<table><tr><th>终端</th><th>关联订单</th><th>说明</th><th>进入时间</th><th>处理</th></tr>
            ${groups[cat].map((q) => `<tr>
              <td class="mono">${q.terminal_id || '—'}</td>
              <td>${q.order_id ? `<a onclick="openOrder('${q.order_id}')" style="color:var(--indigo-600);cursor:pointer" class="mono">${q.order_id.slice(-8)}</a> · ${yuan(q.order_amount)}` : '—'}</td>
              <td>${esc(q.note || '')}</td><td class="mono">${q.created_at}</td>
              <td style="white-space:nowrap">${reviewActions(q, cat)}</td></tr>`).join('')}</table>`
            : '<div class="empty">无待处理</div>'}
        `).join('')}
      </div>
    </div>
    <div class="card">
      <h2>故障工单</h2>
      <table>
        <tr><th>级别</th><th>类型</th><th>终端</th><th>说明</th><th>关联订单</th><th>处理人</th><th>状态</th><th>操作</th></tr>
        ${list.map((f) => `<tr>
          <td>${f.severity === 'high' ? tag('高', 'red') : tag('普通', 'gray')}</td>
          <td>${tag(FAULT_KIND[f.kind] || f.kind, 'indigo')}</td>
          <td class="mono">${f.terminal_id}</td><td>${esc(f.summary)}</td>
          <td>${f.order_id ? `<a onclick="openOrder('${f.order_id}')" style="color:var(--indigo-600);cursor:pointer" class="mono">${f.order_id.slice(-8)}</a>` : '—'}</td>
          <td>${esc(f.assignee || '—')}</td><td>${statusTag(FAULT_STATUS, f.status)}</td>
          <td style="white-space:nowrap">
            ${['open', 'in_repair'].includes(f.status) ? `
              <button class="act mini" onclick="reissue('${f.id}','${f.terminal_id}')">人工补票</button>
              <button class="act yellow mini" onclick="assignFault('${f.id}')">派单</button>
              <button class="act ghost mini" onclick="resolveFault('${f.id}')">修复并恢复</button>` : ''}
          </td></tr>`).join('')}
      </table>
    </div>`;
}

function reviewActions(q, cat) {
  const dismiss = `<button class="act ghost mini" onclick="settleReview('${q.id}','dismissed')">忽略</button>`;
  if (cat === 'paid_no_ticket') {
    return `<button class="act yellow mini" onclick="goRefund('${q.order_id}')">发起退款</button>
            <button class="act mini" onclick="fromFaultReissue('${q.terminal_id}','${q.fault_id}')">人工补票</button>${dismiss}`;
  }
  if (cat === 'duplicate_ticket') {
    return `<button class="act yellow mini" onclick="goRefund('${q.order_id}')">退重复票款</button>
            <button class="act ghost mini" onclick="settleReview('${q.id}','manual_ticket')">标记作废</button>`;
  }
  if (cat === 'refund_timeout') {
    return `<a class="act yellow mini" style="text-decoration:none" onclick="gotoView('refunds')">前往退款台账处理</a>`;
  }
  if (cat === 'roll_reversed') {
    return `<button class="act mini" onclick="settleReview('${q.id}','dismissed');toast('已通知重新装卷','ok')">通知重装</button>${dismiss}`;
  }
  if (cat === 'offline') {
    return `<button class="act mini" onclick="resync('${q.terminal_id}')">补传心跳</button>${dismiss}`;
  }
  return dismiss;
}

window.settleReview = async (id, status) => {
  await post(`/api/review/${id}/settle`, { status, handler: '值班员' });
  toast('复核已处理：' + status, 'ok'); render();
};
window.goRefund = (oid) => { gotoView('refunds', oid); };
window.gotoView = async (v, prefillOrder) => {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  currentView = v; await render();
  if (prefillOrder) {
    const inp = $('#refundOrderId');
    if (inp) { inp.value = prefillOrder; inp.focus(); }
    openRefundByOrder(prefillOrder);
  }
};
window.fromFaultReissue = async (tid, fid) => {
  const op = prompt('人工补票处理人：', '票务员-陈晨');
  if (!op) return;
  try {
    const r = await post('/api/manual-reissue', { terminalId: tid, faultId: fid, operator: op });
    toast('人工补票成功：' + r.ticket.ticket_code + '（已关联故障工单）', 'ok'); render();
  } catch (e) { toast(e.message, 'err'); }
};
window.reissue = async (fid, tid) => window.fromFaultReissue(tid, fid);
window.assignFault = async (id) => {
  const op = prompt('指派给：', '维修员-冯工');
  if (!op) return;
  await post(`/api/faults/${id}/assign`, { operator: op });
  toast('已派单', 'ok'); render();
};
window.resolveFault = async (id) => {
  await post(`/api/faults/${id}/resolve`, { resolution: '现场已修复，试打正常' });
  toast('工单已修复，终端满足条件则恢复发票', 'ok'); render();
};
window.resync = async (tid) => {
  const evId = 'EVT-MANUAL-' + tid + '-' + Date.now();
  const r = await post(`/api/offline/${tid}/sync`, { clientEventId: evId, kind: 'heartbeat', payload: {} });
  toast(r.duplicated ? '重复补传已被去重' : '心跳补传成功，终端恢复在线', 'ok'); render();
};

/* ============== 视图 5：订单核验 ============== */
async function renderOrders() {
  const { orders: list } = await get('/api/orders?limit=300');
  view.innerHTML = `
    <div class="card">
      <h2>收款订单核验 <span class="muted">— 点击订单查看 支付/票据/工单/回执 完整核验链</span></h2>
      <div class="toolbar">
        <input id="simRequest" placeholder="幂等键 client_request_id（相同键重放只扣一次）" style="width:300px">
        <select id="simTerminal">${(await get('/api/terminals')).terminals.map((t) => `<option value="${t.id}">${t.id}</option>`).join('')}</select>
        <input id="simItem" value="东站→西站 单程票" style="width:180px">
        <input id="simAmount" type="number" value="55" style="width:90px">
        <button class="act yellow" onclick="simPurchase()">模拟购票</button>
        <span class="muted">金额单位：元（模拟）</span>
      </div>
      <table>
        <tr><th>订单</th><th>终端</th><th>票品</th><th>金额</th><th>状态</th><th>支付流水</th><th>失败原因</th><th>时间</th></tr>
        ${list.map((o) => `<tr style="cursor:pointer" onclick="openOrder('${o.id}')">
          <td class="mono">${o.id.slice(-8)}</td><td class="mono">${o.terminal_id}</td>
          <td>${esc(o.item)}</td><td class="pill-amount">${yuan(o.amount)}</td>
          <td>${statusTag(ORDER_STATUS, o.status)}</td>
          <td class="mono">${o.pay_ref ? esc(o.pay_ref) : '—'}</td>
          <td>${o.fail_reason ? tag(FAULT_KIND[o.fail_reason] || o.fail_reason, 'red') : '—'}</td>
          <td class="mono">${o.created_at}</td></tr>`).join('')}
      </table>
    </div>`;
}

window.simPurchase = async () => {
  const requestId = $('#simRequest').value.trim() || 'REQ-UI-' + Date.now();
  const terminalId = $('#simTerminal').value;
  const item = $('#simItem').value || '模拟票';
  const amountFen = Math.round(Number($('#simAmount').value || 0) * 100);
  try {
    const r = await post('/api/purchase', { terminalId, requestId, item, amountFen });
    if (r.idempotent) toast('幂等命中：返回原订单，未重复扣款/出票', 'ok');
    else if (r.failed) toast('扣款成功但出票失败（' + r.reason + '），已进故障+复核', 'err');
    else toast('出票成功：' + r.ticket.ticket_code, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
};

window.openOrder = async (id) => {
  const v = await get('/api/orders/' + id + '/verify');
  if (!v) return toast('订单不存在', 'err');
  const o = v.order;
  const chain = [];
  chain.push(chainItem('yellow', '① 原订单', `
    <div class="kv">
      <dt>订单号</dt><dd class="mono">${o.id}</dd>
      <dt>终端</dt><dd class="mono">${o.terminal_id}</dd>
      <dt>票品</dt><dd>${esc(o.item)}</dd>
      <dt>金额</dt><dd class="pill-amount">${yuan(o.amount)}</dd>
      <dt>状态</dt><dd>${statusTag(ORDER_STATUS, o.status)}</dd>
      <dt>下单时间</dt><dd class="mono">${o.created_at}</dd>
    </div>`));
  if (v.payment) chain.push(chainItem('green', '② 支付扣款（模拟适配器）', `
    <div class="kv">
      <dt>流水号</dt><dd class="mono">${esc(v.payment.ref)}</dd>
      <dt>金额</dt><dd>${yuan(v.payment.amount)}</dd>
      <dt>结果</dt><dd>${v.payment.status === 'success' ? tag('扣款成功', 'green') : tag('失败', 'red')}</dd>
      <dt>时间</dt><dd class="mono">${v.payment.created_at}</dd>
    </div>`));
  chain.push(chainItem(v.tickets.length ? '' : 'red', '③ 票据（连续号段台账）', v.tickets.length ? `
    <table>${v.tickets.map((t) => `<tr><td class="mono" style="font-size:15px;font-weight:700;color:var(--indigo-800)">${t.ticket_code}</td>
      <td>${tag({ sale: '正常销售', manual_reissue: '人工补票', duplicate: '重复出票' }[t.issue_type] || t.issue_type, t.issue_type === 'duplicate' ? 'red' : 'indigo')}</td>
      <td>${tag({ printed: '已打印', void_jam: '卡纸作废', duplicate: '重复' }[t.status] || t.status, t.status === 'printed' ? 'green' : 'red')}</td>
      <td class="mono">${t.issued_at}</td></tr>`).join('')}</table>`
    : '<b style="color:var(--red)">无票据记录：扣款成功未出票</b>'));
  if (v.receipts.length) chain.push(chainItem('', '④ 设备回执（本地文件）', `
    ${v.receipts.map((r) => `<div style="margin:4px 0"><span class="tag indigo">${r.kind}</span>
      <a href="${fileUrl(r.file_path)}" target="_blank" class="mono" style="margin-left:8px">${esc(r.file_path)}</a>
      <span class="muted"> · ${r.created_at}</span></div>`).join('')}`));
  if (v.faults.length) chain.push(chainItem('red', '⑤ 故障工单', v.faults.map((f) =>
    `<div style="margin:3px 0">${tag(FAULT_KIND[f.kind] || f.kind, 'red')} ${statusTag(FAULT_STATUS, f.status)} ${esc(f.summary)} <span class="mono muted">${f.id}</span></div>`).join('')));
  const refundActions = !v.refunds.some((r) => ['requested', 'approved', 'success'].includes(r.status)) && o.pay_ref
    ? `<div style="margin-top:12px"><button class="act yellow" onclick="openRefundByOrder('${o.id}')">对该原订单发起退款（仅一次）</button></div>` : '';
  chain.push(chainItem('green', '⑥ 处理动作 · 退款', v.refunds.length ? v.refunds.map((r) =>
    `<div style="margin:3px 0">${statusTag(REFUND_STATUS, r.status)} <span class="mono">${r.id}</span>
     <span class="muted">${esc(r.reason)} · ${r.reviewer || ''} · ${r.decided_at || r.created_at}</span></div>`).join('') + refundActions
    : (o.pay_ref ? '该订单尚未发起退款。' + refundActions : '订单未真实扣款，不可退款。')));

  drawer('订单核验 · ' + o.id.slice(-8), `<div class="chain">${chain.join('')}</div>`);
};

function chainItem(cls, title, html) {
  return `<div class="chain-item ${cls}"><div class="chain-box">
    <div class="ch-title">${title}</div>${html}</div></div>`;
}

/* ============== 视图 6：退款台账（纵向证据链） ============== */
async function renderRefunds() {
  const { refunds: list } = await get('/api/refunds');
  view.innerHTML = `
    <div class="card">
      <h2>退款台账 <span class="muted">— 退款只允许对应原订单一次；按 原订单 → 设备回执 → 处理动作 纵向证据链核验</span></h2>
      <form class="row" id="refundForm" style="margin:10px 0 16px">
        <label class="fl">原订单号<input name="orderId" id="refundOrderId" placeholder="OD_..." required style="width:230px"></label>
        <label class="fl">退款原因<input name="reason" value="扣款成功未出票，旅客申请" style="width:260px"></label>
        <label class="fl">发起人<input name="reviewer" value="客服-周敏" style="width:140px"></label>
        <button class="act yellow">发起退款</button>
        <span class="muted">每笔原订单最多一条有效退款</span>
      </form>
      <table>
        <tr><th>退款单</th><th>原订单</th><th>终端</th><th>票品</th><th>金额</th><th>原因</th><th>状态</th><th>处理人</th><th>证据链</th></tr>
        ${list.map((r) => `<tr>
          <td class="mono">${r.id.slice(-8)}</td>
          <td><a class="mono" style="color:var(--indigo-600);cursor:pointer" onclick="openOrder('${r.order_id}')">${r.order_id.slice(-8)}</a></td>
          <td class="mono">${r.terminal_id}</td><td>${esc(r.order_item)}</td>
          <td class="pill-amount">${yuan(r.amount)}</td><td>${esc(r.reason)}</td>
          <td>${statusTag(REFUND_STATUS, r.status)}</td><td>${esc(r.reviewer || '—')}</td>
          <td><button class="act ghost mini" onclick="openRefund('${r.id}')">证据链</button></td></tr>`).join('')}
      </table>
    </div>`;
  $('#refundForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await post('/api/refund-request', {
        orderId: f.get('orderId').trim(), reason: f.get('reason'), reviewer: f.get('reviewer')
      });
      toast('退款已发起：' + r.refund.id.slice(-8), 'ok');
      openRefund(r.refund.id); render();
    } catch (err) { toast(err.message, 'err'); }
  });
}

window.openRefundByOrder = async (oid) => {
  // 若尚未有退款单，尝试直接打开发起抽屉预填
  const inp = $('#refundOrderId');
  if (inp) inp.value = oid;
  const { refunds: list } = await get('/api/refunds');
  const r = list.find((x) => x.order_id === oid);
  if (r) openRefund(r.id);
  else drawer('发起退款', `
    <div class="chain">
      ${chainItem('yellow', '① 原订单', `<div class="kv"><dt>订单号</dt><dd class="mono">${oid}</dd></div>
        <div class="muted" style="margin-top:6px">请在退款台账页面点击“发起退款”，系统会校验该订单仅可退款一次。</div>`)}
      ${chainItem('', '② 设备回执', '提交审批时自动快照订单、支付、票据、回执、工单。')}
      ${chainItem('green', '③ 处理动作', '<button class="act yellow" onclick="closeDrawer()">我知道了</button>')}
    </div>`);
};

window.openRefund = async (id) => {
  const { refund, snapshot, live } = await get('/api/refunds/' + id + '/evidence');
  const o = live.original_order;
  const decideBar = ['requested', 'timeout'].includes(refund.status) ? `
    <div class="row" style="margin-top:14px">
      <input id="rvwName" value="主管-郑凯" placeholder="审批人" style="width:150px">
      <button class="act yellow" onclick="decide('${id}','approve')">批准并退款</button>
      <button class="act danger" onclick="decide('${id}','reject')">驳回</button>
    </div>` : `<div style="margin-top:10px">${statusTag(REFUND_STATUS, refund.status)} 审批人：${esc(refund.reviewer || '—')} · ${refund.decided_at || ''}</div>`;

  drawer('退款证据链 · ' + refund.id.slice(-8), `
    <div class="chain">
      ${chainItem('yellow', '① 原订单', `
        <div class="kv">
          <dt>原订单号</dt><dd class="mono">${o.id}</dd>
          <dt>终端</dt><dd class="mono">${o.terminal}</dd>
          <dt>票品</dt><dd>${esc(o.item)}</dd>
          <dt>金额</dt><dd class="pill-amount">${yuan(o.amount_fen)}</dd>
          <dt>订单状态</dt><dd>${esc(o.status)}</dd>
          <dt>原支付流水</dt><dd class="mono">${esc(o.pay_ref || '—')}</dd>
        </div>`)}
      ${chainItem('green', '② 支付凭证', live.payment ? `
        <div class="kv"><dt>流水</dt><dd class="mono">${esc(live.payment.ref)}</dd>
        <dt>金额</dt><dd>${yuan(live.payment.amount_fen)}</dd>
        <dt>结果</dt><dd>${tag(live.payment.status === 'success' ? '扣款成功' : live.payment.status, 'green')}</dd></div>`
        : '<b class="muted">无支付记录</b>')}
      ${chainItem('', '③ 票据记录', live.tickets.length ? live.tickets.map((t) =>
        `<div style="margin:3px 0"><span class="mono" style="font-weight:700;color:var(--indigo-800)">${t.code}</span>
        ${tag({ sale: '销售', manual_reissue: '人工补票', duplicate: '重复' }[t.type] || t.type, 'indigo')}
        ${tag(t.status, t.status === 'printed' ? 'green' : 'red')} <span class="muted">${t.at}</span></div>`).join('')
        : '<b style="color:var(--red)">无票据（未出票）</b>')}
      ${chainItem('', '④ 设备回执（本地文件）', live.device_receipts.length ? live.device_receipts.map((r) =>
        `<div style="margin:4px 0"><span class="tag indigo">${r.kind}</span>
        <a href="${fileUrl(r.file)}" target="_blank" class="mono" style="margin-left:8px">${esc(r.file)}</a>
        <div class="muted">${r.at}</div></div>`).join('')
        : '<span class="muted">无设备回执文件</span>')}
      ${chainItem('red', '⑤ 关联故障工单', live.fault_tickets.length ? live.fault_tickets.map((f) =>
        `<div style="margin:3px 0">${tag(FAULT_KIND[f.kind] || f.kind, 'red')} ${statusTag(FAULT_STATUS, f.status)} ${esc(f.summary)}</div>`).join('')
        : '<span class="muted">无关联工单</span>')}
      ${chainItem('green', '⑥ 处理动作', `
        <div class="kv">
          <dt>退款状态</dt><dd>${statusTag(REFUND_STATUS, refund.status)}</dd>
          <dt>申请原因</dt><dd>${esc(refund.reason)}</dd>
          <dt>发起人</dt><dd>${esc(refund.reviewer || '—')}</dd>
          <dt>金额</dt><dd class="pill-amount">${yuan(refund.amount)}</dd>
          <dt>申请时间</dt><dd class="mono">${refund.created_at}</dd>
          <dt>快照时间</dt><dd class="mono">${snapshot?.at || '审批后生成'}</dd>
        </div>${decideBar}`)}
    </div>
  `);
};

window.decide = async (id, decision) => {
  const reviewer = $('#rvwName').value.trim() || '主管';
  try {
    await post(`/api/refunds/${id}/decide`, { decision, reviewer });
    toast(decision === 'approve' ? '退款成功，证据链已归档为本地回执' : '已驳回', decision === 'approve' ? 'ok' : 'err');
    closeDrawer(); render();
  } catch (e) { toast(e.message, 'err'); }
};

/* ============== 抽屉 ============== */
function drawer(title, html) {
  closeDrawer();
  const mask = document.createElement('div');
  mask.className = 'drawer-mask';
  mask.id = 'drawerMask';
  mask.innerHTML = `<div class="drawer" onclick="event.stopPropagation()">
    <div class="drawer-head"><h2>${esc(title)}</h2><button class="act ghost" onclick="closeDrawer()">关闭 ✕</button></div>
    <div id="drawerBody">${html}</div>
  </div>`;
  mask.addEventListener('click', closeDrawer);
  document.body.appendChild(mask);
}
function closeDrawer() { $('#drawerMask')?.remove(); }
window.closeDrawer = closeDrawer;

/* ============== 启动 ============== */
render().catch((e) => toast('初始化失败：' + e.message, 'err'));
