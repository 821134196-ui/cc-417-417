/* 票务自助机平台前端(原生 JS,无构建) */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const STATUS_TEXT = {
  normal: "正常", no_paper: "缺纸/号段尽", jam: "卡纸", offline: "离线",
  paid: "已付款未出票", ticketed: "已出票", refunding: "退款中",
  refunded: "已退款", failed: "支付失败", paying: "支付中",
  pending: "待处理", reviewing: "复核中", resolved: "已核销", dismissed: "已忽略",
  in_stock: "在库", installed: "已装机", used_up: "已用完",
  active: "使用中", exhausted: "号段尽", retired: "已退役",
  locked: "已锁定", done: "已完成", cancelled: "已取消",
  approved: "已批准", rejected: "已驳回", timeout: "审批超时",
  open: "待处理", in_review: "处理中",
  planned: "计划中", in_progress: "进行中",
  ok: "正常", duplicate: "重复", manual: "人工补票", void: "作废",
};
const KIND_TEXT = {
  payment_no_ticket: "扣款未出票", dup_issue: "重复出票",
  refund_timeout: "退款超时", roll_reversed: "纸卷倒装", offline: "设备离线",
  no_paper: "号段用尽", jam: "卡纸",
};

let state = { overview: null, batches: [], routes: [], receipts: [], workOrders: [] };
const currentUser = { supervisor: "u_wang", replenisher: "u_lin", finance: "u_qian", viewer: "u_view" };

function role() { return $("#roleSelect").value; }
function badge(v) {
  const cls = (v || "").replace(/[^a-z_]/gi, "_");
  return `<span class="badge b-${cls}">${STATUS_TEXT[v] || v}</span>`;
}
function kindChip(k) {
  return `<span class="kind-chip">${KIND_TEXT[k] || k}</span>`;
}
function fen(n) { return `¥${(n / 100).toFixed(2)}`; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, body) {
  const opt = body ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {};
  const r = await fetch(path, opt);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let toastTimer;
function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}
async function guard(fn) {
  try { await fn(); } catch (e) { toast(e.message, "err"); }
}

/* ---------------- 导航 ---------------- */
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${btn.dataset.view}`));
  refresh();
});
$("#roleSelect").addEventListener("change", refresh);

/* ---------------- 抽屉 ---------------- */
function openDrawer(title, html) {
  $("#drawerTitle").textContent = title;
  $("#drawerBody").innerHTML = html;
  $("#mask").classList.add("show");
  $("#drawer").classList.add("show");
}
function closeDrawer() {
  $("#mask").classList.remove("show");
  $("#drawer").classList.remove("show");
}

/* ---------------- 数据刷新 ---------------- */
async function refresh() {
  const [ov, batches, routes, receipts, wos] = await Promise.all([
    api("/api/overview"), api("/api/batches"), api("/api/routes"),
    api("/api/receipts"), api("/api/work-orders"),
  ]);
  state = { overview: ov, batches, routes, receipts, workOrders: wos };
  renderAll();
}

function renderAll() {
  renderMap();
  renderInventory();
  renderRoutes();
  renderFaults();
  renderOrders();
  renderRefunds();
  fillTerminalSelects();
}

/* ---------------- 终端地图 ---------------- */
function gaugeHtml(pct) {
  const bars = 10;
  const on = Math.round((pct / 100) * bars);
  let cells = "";
  for (let i = 0; i < bars; i++) {
    const lit = i < on;
    const cls = lit ? `on${pct <= 20 ? " low" : ""}` : "empty";
    cells += `<i class="${cls}"></i>`;
  }
  return `<div class="gauge">${cells}</div>`;
}

function termNodeClass(t) {
  if (!t.online) return "offline";
  if (t.status === "jam") return "fault";
  if (t.status === "no_paper") return "nopaper";
  return "";
}
function termStatusBadge(t) {
  if (!t.online) return '<span class="tn-status st-offline">离线</span>';
  if (t.status === "jam") return '<span class="tn-status st-fault">卡纸</span>';
  if (t.status === "no_paper") return '<span class="tn-status st-paper">无纸</span>';
  return '<span class="tn-status st-online">在线</span>';
}

function renderMap() {
  const { terminals, stats } = state.overview;
  $("#mapStats").innerHTML = `
    <div class="card"><div class="k">终端总数</div><div class="v">${stats.terminals}</div></div>
    <div class="card"><div class="k">在线</div><div class="v">${stats.online}<small> / ${stats.terminals}</small></div></div>
    <div class="card ${stats.faults ? "alert" : ""}"><div class="k">故障停车</div><div class="v">${stats.faults}</div></div>
    <div class="card"><div class="k">纸卷余量合计</div><div class="v">${stats.paper_total}<small> 张</small></div></div>
    <div class="card ${stats.paid_no_ticket ? "warn" : ""}"><div class="k">扣款未出票</div><div class="v">${stats.paid_no_ticket}</div></div>
    <div class="card ${stats.pending_review ? "alert" : ""}"><div class="k">待复核</div><div class="v">${stats.pending_review}</div></div>`;

  $("#map").innerHTML = terminals.map((t) => {
    const pct = t.paper_capacity ? Math.round((t.paper_remaining / t.paper_capacity) * 100) : 0;
    return `
    <div class="terminal-node ${termNodeClass(t)}" style="left:${t.map_x}%;top:${t.map_y}%"
         onclick='showTerminal("${t.id}")'>
      <div class="tn-head"><span>${t.id}</span>${termStatusBadge(t)}</div>
      <div class="tn-loc">${esc(t.name)} · ${esc(t.location)}</div>
      ${gaugeHtml(pct)}
      <div class="tn-meta"><span>余量 ${t.paper_remaining}/${t.paper_capacity}</span><span>${pct}%</span></div>
      <div class="tn-seg">${t.seg_start != null
        ? `<code>T${String(t.seg_next).padStart(8, "0")}</code> ← 下一张`
        : '<span class="muted">无号段</span>'}</div>
    </div>`;
  }).join("");
}

function showTerminal(tid) {
  const t = state.overview.terminals.find((x) => x.id === tid);
  const orders = state.overview.orders.filter((o) => o.terminal_id === tid).slice(0, 8);
  const pct = t.paper_capacity ? Math.round((t.paper_remaining / t.paper_capacity) * 100) : 0;
  openDrawer(`${t.id} · ${esc(t.name)}`, `
    <div class="split2">
      <div class="card"><div class="k">在线状态</div><div class="v" style="font-size:17px">
        ${termStatusBadge(t)} ${badge(t.status)}</div></div>
      <div class="card"><div class="k">最后心跳</div><div class="v" style="font-size:14px">${esc(t.last_heartbeat || "-")}</div></div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>纸卷与号段</h3>
      ${gaugeHtml(pct)}
      <p class="muted">余量 ${t.paper_remaining}/${t.paper_capacity} 张 · 上次补给 ${esc(t.last_replenished_at || "-")}</p>
      <table class="grid">
        <tr><th>当前批次</th><td><code>${esc(t.current_batch_id || "-")}</code></td></tr>
        <tr><th>号段区间</th><td class="mono">${t.seg_start ?? "-"} ~ ${t.seg_end ?? "-"}</td></tr>
        <tr><th>下一票号</th><td class="mono">T${t.seg_next != null ? String(t.seg_next).padStart(8, "0") : "-"}</td></tr>
      </table>
    </div>
    <div class="panel">
      <h3>最近订单</h3>
      <table class="grid">${orders.map((o) => `
        <tr><td><code>${esc(o.order_no)}</code></td><td>${fen(o.amount_fen)}</td>
        <td>${badge(o.status)}</td><td class="mono">${esc(o.ticket_no || "-")}</td></tr>`).join("") ||
        '<tr><td class="muted">暂无</td></tr>'}</table>
    </div>
    <div class="btn-row">
      ${!t.online
        ? `<button class="btn yellow" onclick='guard(async()=>{await api("/api/terminals/online",{terminal_id:"${tid}"});toast("已恢复在线并补传离线事件","ok");await refresh();showTerminal("${tid}")})'>恢复在线并补传</button>`
        : `<button class="btn ghost" onclick='guard(async()=>{await api("/api/terminals/offline",{terminal_id:"${tid}"});toast("终端已离线","ok");await refresh();showTerminal("${tid}")})'>模拟离线</button>`}
      <button class="btn ghost" onclick='guard(async()=>{await api("/api/tasks/create",{terminal_id:"${tid}",note:"终端详情发起"});toast("已创建补给任务");await refresh()})'>创建补给任务</button>
    </div>`);
}

/* ---------------- 纸卷库存 ---------------- */
function renderInventory() {
  const bs = state.batches;
  const inStock = bs.filter((b) => b.status === "in_stock").length;
  const sheets = bs.filter((b) => b.status === "in_stock")
    .reduce((s, b) => s + b.remaining_count, 0);
  $("#invStats").innerHTML = `
    <div class="card"><div class="k">批次总数</div><div class="v">${bs.length}</div></div>
    <div class="card"><div class="k">在库批次</div><div class="v">${inStock}</div></div>
    <div class="card"><div class="k">在库票数</div><div class="v">${sheets}<small> 张</small></div></div>`;
  $("#batchTable").innerHTML = `
    <tr><th>批次</th><th>供应商</th><th>号段</th><th>容量/余量</th><th>方向</th><th>状态</th>
    <th>装机终端</th><th>入库时间</th></tr>
    ${bs.map((b) => `
    <tr>
      <td><code>${esc(b.id)}</code></td>
      <td>${esc(b.supplier)}</td>
      <td class="mono">${String(b.segment_start).padStart(8, "0")} ~ ${String(b.segment_end).padStart(8, "0")}</td>
      <td>${b.ticket_count} / ${b.remaining_count}</td>
      <td>${b.reversed ? '<span class="badge b-roll_reversed">倒装</span>' : '<span class="muted">正常</span>'}</td>
      <td>${badge(b.status)}</td>
      <td>${esc(b.installed_terminal || "-")}</td>
      <td class="muted">${esc(b.received_at)}</td>
    </tr>`).join("")}`;
}

async function receiveBatch() {
  await guard(async () => {
    const bid = await api("/api/batches/receive", {
      supplier: $("#nb_supplier").value,
      ticket_count: +$("#nb_count").value,
      segment_start: +$("#nb_start").value,
      segment_end: +$("#nb_end").value,
      reversed: $("#nb_rev").value === "1",
    });
    toast(`纸卷已入库:${bid.batch_id}`, "ok");
    await refresh();
  });
}

/* ---------------- 补给路线 / 任务 ---------------- */
function renderRoutes() {
  const tasks = state.overview.tasks;
  const terms = Object.fromEntries(state.overview.terminals.map((t) => [t.id, t]));

  $("#routesList").innerHTML = state.routes.map((r) => {
    const stops = r.task_ids.map((tid) => {
      const task = tasks.find((t) => t.id === tid);
      const label = task ? terms[task.terminal_id]?.id : "?";
      return `<span class="stop">${label} ${task ? badge(task.status) : ""}</span>`;
    }).join('<span class="arrow">→</span>');
    return `<div class="panel">
      <h3>${esc(r.name)} ${badge(r.status)}</h3>
      <div class="route-line">${stops}</div>
      <p class="muted">创建于 ${esc(r.created_at)} · ${r.task_ids.length} 个任务</p>
    </div>`;
  }).join("") || '<div class="panel muted">暂无路线</div>';

  $("#taskList").innerHTML = `
    <table class="grid">
      <tr><th>任务</th><th>终端</th><th>状态</th><th>锁定者</th><th>扫码开柜</th>
      <th>换卷/计数器照片</th><th>操作</th></tr>
      ${tasks.map((t) => {
        const canAct = role() === "replenisher" || role() === "supervisor";
        let photoCell = "-";
        if (t.photo_before) {
          const pb = "/files/" + t.photo_before.split(/[\\/]/).slice(-2).join("/");
          const pa = "/files/" + t.photo_after.split(/[\\/]/).slice(-2).join("/");
          photoCell = `<a href="${pb}" target="_blank">前</a> / <a href="${pa}" target="_blank">后</a>
            <br><span class="muted mono">${t.counter_before} → ${t.counter_after}</span>`;
        }
        let actions = "";
        if (t.status === "pending" && canAct) {
          actions = `<button class="btn yellow" onclick='claimTask("${t.id}")'>扫码开柜并领取</button>`;
        } else if (t.status === "locked") {
          actions = `<span class="muted">锁定者:${esc(t.locked_by)}</span>`;
          if ((role() === "replenisher" || role() === "supervisor")) {
            actions += ` <button class="btn" onclick='completeTaskDialog("${t.id}")'>换卷完成</button>
              <button class="btn ghost" onclick='claimTask("${t.id}")'>他人再领(应失败)</button>`;
          }
        }
        return `<tr>
          <td><code>${esc(t.id)}</code><br><span class="muted">${esc(t.note || "")}</span></td>
          <td>${esc(t.terminal_id)}</td>
          <td>${badge(t.status)}</td>
          <td>${esc(t.locked_by || "-")}</td>
          <td><code style="font-size:10px">${esc(t.scan_code || "-")}</code></td>
          <td>${photoCell}</td>
          <td><div class="btn-row">${actions}</div></td>
        </tr>`;
      }).join("")}
    </table>`;

  const sel = $("#newTaskTerm");
  sel.innerHTML = state.overview.terminals
    .filter((t) => t.status !== "normal")
    .map((t) => `<option value="${t.id}">${t.id} · ${esc(t.name)}(${STATUS_TEXT[t.status]})</option>`)
    .join("") || state.overview.terminals.map((t) =>
      `<option value="${t.id}">${t.id} · ${esc(t.name)}</option>`).join("");
}

async function createTask() {
  await guard(async () => {
    await api("/api/tasks/create", {
      terminal_id: $("#newTaskTerm").value,
      note: $("#newTaskNote").value,
    });
    toast("补给任务已创建", "ok");
    await refresh();
  });
}

async function claimTask(taskId) {
  await guard(async () => {
    const task = state.overview.tasks.find((t) => t.id === taskId);
    const res = await api("/api/tasks/claim", {
      task_id: taskId, user_id: currentUser[role()], scan_code: task.scan_code,
    });
    if (res.won) toast("开柜成功,任务已由你锁定", "ok");
    else toast(`已被 ${res.locked_by} 锁定,你无法重复领取`, "err");
    await refresh();
  });
}

function completeTaskDialog(taskId) {
  const inStock = state.batches.filter((b) => b.status === "in_stock" && !b.reversed);
  const reversedCount = state.batches.filter(
    (b) => b.status === "in_stock" && b.reversed).length;
  openDrawer("换卷完成 · 计数器照片留痕", `
    <div class="flash">换卷前后计数器读数将生成照片并存入本地 <code>data/photos/</code>,与任务一同存档。</div>
    ${reversedCount ? `<div class="flash" style="background:#fdecea;border-color:#e3b3b3;color:#8f1d1d">
      库存中有 ${reversedCount} 卷倒装纸卷,已从可选列表排除。</div>` : ""}
    <label class="fld">选择新纸卷(在库 ${inStock.length} 卷)</label>
    <select id="ct_batch" style="width:100%">
      ${inStock.length ? inStock.map((b) => `<option value="${b.id}">${b.id} · 号段 ${b.segment_start}~${b.segment_end}</option>`).join("")
        : '<option value="">没有可用的正常纸卷,请先入库</option>'}
    </select>
    <div class="split2">
      <div><label class="fld">换卷前计数器</label><input id="ct_before" type="number" class="mono" value="0" style="width:100%"></div>
      <div><label class="fld">换卷后计数器</label><input id="ct_after" type="number" class="mono" value="200" style="width:100%"></div>
    </div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn yellow" onclick='guard(async()=>{
        const r=await api("/api/tasks/complete",{task_id:"${taskId}",user_id:currentUser[role()],
          batch_id:$("#ct_batch").value,counter_before:+$("#ct_before").value,counter_after:+$("#ct_after").value});
        toast("换卷完成,前后照片已留存","ok");closeDrawer();await refresh();
      })'>确认换卷</button>
      <button class="btn ghost" onclick="closeDrawer()">取消</button>
    </div>`);
}

/* ---------------- 故障队列 ---------------- */
function renderFaults() {
  const rq = state.overview.review_queue;
  const counts = {};
  rq.filter((r) => r.status === "pending").forEach((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1));
  $("#faultStats").innerHTML =
    ["payment_no_ticket", "dup_issue", "refund_timeout", "roll_reversed", "offline"].map((k) =>
      `<div class="card ${counts[k] ? "alert" : ""}"><div class="k">${KIND_TEXT[k]}</div>
       <div class="v">${counts[k] || 0}</div></div>`).join("");

  $("#reviewTable").innerHTML = `
    <tr><th>#</th><th>类型</th><th>终端</th><th>关联对象</th><th>说明</th><th>状态</th><th>时间</th><th>操作</th></tr>
    ${rq.map((r) => `<tr>
      <td>${r.id}</td><td>${kindChip(r.kind)}</td><td>${esc(r.terminal_id || "-")}</td>
      <td><code>${esc(r.ref_type)}:${esc(r.ref_id)}</code></td>
      <td style="max-width:300px">${esc(r.detail)}</td>
      <td>${badge(r.status)}</td><td class="muted">${esc(r.created_at)}</td>
      <td>${r.status === "pending" && (role() === "supervisor" || role() === "finance")
        ? `<button class="btn ghost" onclick='guard(async()=>{await api("/api/review/resolve",{review_id:${r.id},resolution:"人工核验无误",role:role()});toast("已核销");await refresh()})'>核销</button>`
        : ""}</td>
    </tr>`).join("")}`;

  $("#woTable").innerHTML = `
    <tr><th>工单</th><th>终端</th><th>类型</th><th>关联订单</th><th>描述</th><th>状态</th>
    <th>补票</th><th>操作</th></tr>
    ${state.workOrders.map((w) => `<tr>
      <td><code>${esc(w.id)}</code></td>
      <td>${esc(w.terminal_id)}</td><td>${kindChip(w.kind)}</td>
      <td>${w.related_order ? `<code>${esc(w.related_order)}</code>` : "-"}</td>
      <td style="max-width:280px">${esc(w.description)}</td>
      <td>${badge(w.status)}</td>
      <td>${w.manual_ticket_no ? `<code>${esc(w.manual_ticket_no)}</code>` : "-"}</td>
      <td><div class="btn-row">
        ${w.status !== "resolved" && w.related_order
          ? `<button class="btn yellow" onclick='manualIssue("${w.id}")'>人工补票</button>` : ""}
        ${w.status !== "resolved"
          ? `<button class="btn ghost" onclick='guard(async()=>{await api("/api/work-orders/resolve",{work_order_id:"${w.id}",resolution:"现场处理完成",role:role()});toast("工单已处理");await refresh()})'>处理结案</button>`
          : `<span class="muted">${esc(w.resolution || "")}</span>`}
      </div></td>
    </tr>`).join("")}`;
}

async function manualIssue(woId) {
  await guard(async () => {
    const r = await api("/api/work-orders/manual-issue", {
      work_order_id: woId, role: role(),
    });
    toast(`人工补票成功:${r.ticket_no}(已关联工单 ${woId})`, "ok");
    await refresh();
  });
}

/* ---------------- 订单核验 ---------------- */
function renderOrders() {
  const orders = state.overview.orders;
  $("#orderTable").innerHTML = `
    <tr><th>订单号</th><th>幂等键</th><th>终端</th><th>金额</th><th>状态</th>
    <th>票号</th><th>创建</th><th>证据</th></tr>
    ${orders.map((o) => `<tr>
      <td><code>${esc(o.order_no)}</code></td>
      <td><code style="font-size:10px">${esc(o.idem_key)}</code></td>
      <td>${esc(o.terminal_id)}</td><td>${fen(o.amount_fen)}</td>
      <td>${badge(o.status)}</td>
      <td class="mono">${esc(o.ticket_no || "-")}</td>
      <td class="muted">${esc(o.created_at)}</td>
      <td><button class="btn ghost" onclick='showEvidence("${esc(o.order_no)}")'>证据链</button></td>
    </tr>`).join("")}`;

  $("#receiptTable").innerHTML = `
    <tr><th>事件</th><th>终端</th><th>类型</th><th>已同步</th><th>本地文件</th></tr>
    ${state.receipts.slice(0, 30).map((r) => `<tr>
      <td><code style="font-size:10px">${esc(r.event_id)}</code></td>
      <td>${esc(r.terminal_id)}</td>
      <td>${esc(r.kind)}</td>
      <td>${r.synced ? badge("resolved") : badge("pending")}
        ${!r.synced ? '<span class="muted">离线暂存</span>' : ""}</td>
      <td><a href="${r.file_url}" target="_blank" class="mono" style="font-size:11px">${esc(r.file_url)}</a></td>
    </tr>`).join("")}`;
}

function fillTerminalSelects() {
  const terms = state.overview.terminals;
  for (const id of ["buyTerm"]) {
    const cur = $(`#${id}`).value;
    $(`#${id}`).innerHTML = terms.map((t) =>
      `<option value="${t.id}">${t.id} · ${esc(t.name)}</option>`).join("");
    if (cur) $(`#${id}`).value = cur;
  }
}

async function doBuy(reuse) {
  await guard(async () => {
    let key = $("#buyIdem").value.trim();
    if (!reuse) {
      // 普通购票:每次生成新幂等键
      key = "idem_demo_" + Math.random().toString(36).slice(2, 10);
      $("#buyIdem").value = key;
    } else if (!key) {
      throw new Error("请先完成一次购票,再用相同幂等键重试");
    }
    const r = await api("/api/buy", {
      terminal_id: $("#buyTerm").value,
      amount_fen: +$("#buyAmount").value,
      idem_key: key,
    });
    if (r.result.replayed) toast("幂等重放:返回原订单,未二次扣款/出票", "ok");
    else if (r.result.blocked) toast(`出票被拦截:${KIND_TEXT[r.result.blocked] || r.result.blocked}(已入复核队列)`, "err");
    else if (r.result.pay_error) toast(`支付问题:${r.result.pay_error}`, "err");
    else toast(`出票成功:${r.result.ticket_no}`, "ok");
    await refresh();
  });
}

async function injectFault(kind) {
  await guard(async () => {
    const tid = $("#buyTerm").value;
    if (kind === "jam") {
      await api("/api/printer/jam", { terminal_id: tid });
      toast("下次出票将卡纸(票号不会跳号)", "ok");
    } else {
      await api("/api/printer/dup", { terminal_id: tid });
      // 立即触发一笔购票,演示同号重打后停车进复核
      $("#buyIdem").value = "idem_dup_" + Math.random().toString(36).slice(2, 8);
      await doBuy(false);
    }
  });
}

async function goOffline() {
  await guard(async () => {
    const tid = $("#buyTerm").value;
    await api("/api/terminals/offline", { terminal_id: tid });
    await api("/api/spool", {
      terminal_id: tid, kind: "sale_attempt",
      payload: { order_no: "ord_spool_" + Math.random().toString(36).slice(2, 8), amount_fen: 500 },
    });
    toast("终端离线,扣款事件已写入本地暂存队列", "ok");
    await refresh();
  });
}
async function goOnline() {
  await guard(async () => {
    const tid = $("#buyTerm").value;
    await api("/api/terminals/online", { terminal_id: tid });
    toast("恢复在线,暂存事件已补传(event_id 去重)", "ok");
    await refresh();
  });
}
async function resetFaults() {
  await guard(async () => {
    await api("/api/printer/reset", { terminal_id: $("#buyTerm").value });
    toast("故障注入已清除", "ok");
  });
}

/* ---------------- 退款台账 + 证据链 ---------------- */
function renderRefunds() {
  const rs = state.overview.refunds;
  const sum = rs.filter((r) => r.status === "refunded").reduce((s, r) => s + r.amount_fen, 0);
  $("#refundStats").innerHTML = `
    <div class="card ${rs.some((r) => r.status === "pending") ? "warn" : ""}">
      <div class="k">待审批</div><div class="v">${rs.filter((r) => r.status === "pending").length}</div></div>
    <div class="card"><div class="k">已退款</div><div class="v">${rs.filter((r) => r.status === "refunded").length}</div></div>
    <div class="card alert"><div class="k">审批超时</div><div class="v">${rs.filter((r) => r.status === "timeout").length}</div></div>
    <div class="card"><div class="k">已驳回</div><div class="v">${rs.filter((r) => r.status === "rejected").length}</div></div>
    <div class="card"><div class="k">退款金额合计</div><div class="v">${fen(sum)}</div></div>`;

  $("#refundTable").innerHTML = `
    <tr><th>退款单</th><th>原订单</th><th>金额</th><th>申请人/原因</th><th>状态</th>
    <th>审批</th><th>证据链</th></tr>
    ${rs.map((r) => `<tr>
      <td><code>${esc(r.id)}</code></td>
      <td><code>${esc(r.order_no)}</code></td>
      <td>${fen(r.amount_fen)}</td>
      <td>${esc(r.applicant)}<br><span class="muted">${esc(r.reason)}</span></td>
      <td>${badge(r.status)}</td>
      <td>${r.status === "pending" ? `
          <button class="btn yellow" onclick='decideRefund("${r.id}","approve")'>批准退款</button>
          <button class="btn danger" onclick='decideRefund("${r.id}","reject")'>驳回</button>`
        : `<span class="muted">${esc(r.decided_by || "")} ${esc(r.decision || "")}</span>`}</td>
      <td><button class="btn ghost" onclick='showEvidence("${esc(r.order_no)}")'>查看证据链</button></td>
    </tr>`).join("")}`;
}

async function applyRefund() {
  await guard(async () => {
    const r = await api("/api/refunds/apply", {
      order_no: $("#rf_order").value.trim(),
      applicant: $("#rf_applicant").value,
      reason: $("#rf_reason").value,
    });
    toast(`退款申请已提交:${r.refund_id}(每订单仅一次)`, "ok");
    await refresh();
  });
}

async function decideRefund(rid, action) {
  await guard(async () => {
    await api("/api/refunds/decide", {
      refund_id: rid, action, role: role(),
      note: action === "approve" ? "同意原路退回" : "核验后驳回",
    });
    toast(action === "approve" ? "退款出款成功" : "已驳回", "ok");
    await refresh();
  });
}

async function showEvidence(orderNo) {
  await guard(async () => {
    const e = await api(`/api/evidence?order_no=${encodeURIComponent(orderNo)}`);
    const o = e.order;
    const rows = [];
    rows.push({
      title: "① 原订单(收款)",
      time: o.created_at,
      badge: badge(o.status),
      body: {
        order_no: o.order_no, idem_key: o.idem_key, terminal: o.terminal_id,
        amount_fen: o.amount_fen, amount: fen(o.amount_fen),
        status: o.status, paid_at: o.paid_at, ticket_no: o.ticket_no,
      },
    });
    e.receipts.forEach((r, i) => rows.push({
      title: `② 设备回执 #${i + 1} · ${r.kind}`,
      time: r.created_at, badge: r.synced ? badge("resolved") : badge("pending"),
      body: r.body,
      file: r.file_path,
    }));
    if (!e.receipts.length) {
      rows.push({ title: "② 设备回执", time: "", badge: "", body: { note: "该订单暂无设备回执文件" } });
    }
    if (e.work_orders.length) {
      e.work_orders.forEach((w) => rows.push({
        title: `③ 故障工单 · ${KIND_TEXT[w.kind] || w.kind}`,
        time: w.created_at, badge: badge(w.status),
        body: { work_order: w.id, kind: w.kind, description: w.description,
          manual_ticket_no: w.manual_ticket_no, resolution: w.resolution },
      }));
    }
    e.refunds.forEach((r) => rows.push({
      title: `④ ${r.status === "refunded" ? "退款出款" : "退款处理"} · ${r.status}`,
      time: r.decided_at || r.created_at, badge: badge(r.status),
      body: { refund_id: r.id, amount: fen(r.amount_fen), applicant: r.applicant,
        reason: r.reason, decided_by: r.decided_by, decision: r.decision,
        refunded_at: r.refunded_at },
    }));
    if (!e.refunds.length) {
      rows.push({ title: "④ 退款处理", time: "", badge: "", body: { note: "尚未发起退款" } });
    }

    openDrawer(`退款证据链 · ${o.order_no}`, `
      <div class="flash">纵向证据链严格按时间排列:原订单 → 设备回执(本地文件) → 工单/退款处理动作。
      一笔原订单最多对应一条退款单。</div>
      <div class="chain">
        ${rows.map((r) => `
          <div class="chain-item">
            <div class="ci-card">
              <div class="ci-title">${esc(r.title)} ${r.badge}
                <span class="ci-time" style="margin-left:auto">${esc(r.time || "")}</span></div>
              ${r.file ? `<div class="muted" style="margin-top:4px">回执文件:<code>${esc(r.file)}</code></div>` : ""}
              <pre>${esc(JSON.stringify(r.body, null, 2))}</pre>
            </div>
          </div>`).join("")}
      </div>
      <div class="btn-row" style="margin-top:10px">
        ${o.status === "ticketed" || o.status === "paid"
          ? `<button class="btn yellow" onclick='goRefund("${esc(o.order_no)}")'>发起退款</button>`
          : ""}
        <button class="btn ghost" onclick="closeDrawer()">关闭</button>
      </div>`);
  });
}

function goRefund(orderNo) {
  closeDrawer();
  $("#rf_order").value = orderNo;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === "refunds"));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-refunds"));
  refresh();
}

/* ---------------- 启动 ---------------- */
refresh().catch((e) => toast("初始化失败:" + e.message, "err"));
setInterval(() => api("/api/overview").then((ov) => {
  state.overview = ov;
  renderMap(); renderFaults(); renderRefunds();
}).catch(() => {}), 8000);
