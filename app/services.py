"""领域服务:号段、订单、纸卷、工单、补给任务、退款、离线补传。

所有写操作都在 `BEGIN IMMEDIATE` 事务中完成,SQLite 写锁保证
多线程/多进程下的纸卷扣减与任务认领原子性。
"""
import json
import os
import time

from . import adapters
from .adapters import new_id, now, payment, printer, write_device_receipt
from .database import rows_to_dicts

TICKET_PREFIX = "T"


def fmt_ticket(n):
    return f"{TICKET_PREFIX}{n:08d}"


# ---------------------------------------------------------------------------
# 内部小工具
# ---------------------------------------------------------------------------

def _txn(conn):
    conn.execute("BEGIN IMMEDIATE")


def _term(conn, terminal_id):
    row = conn.execute("SELECT * FROM terminals WHERE id=?", (terminal_id,)).fetchone()
    if not row:
        raise ValueError(f"终端不存在: {terminal_id}")
    return dict(row)


def enqueue_review(conn, kind, ref_type, ref_id, terminal_id, detail):
    conn.execute(
        """INSERT INTO review_queue(kind,ref_type,ref_id,terminal_id,detail,created_at)
           VALUES(?,?,?,?,?,?)""",
        (kind, ref_type, str(ref_id), terminal_id, detail, now()),
    )


def open_work_order(conn, terminal_id, kind, description, related_order=None):
    wid = new_id("wo")
    conn.execute(
        """INSERT INTO fault_work_orders(id,terminal_id,kind,status,related_order,
              description,created_at) VALUES(?,?,?,?,?,?,?)""",
        (wid, terminal_id, kind, "open", related_order, description, now()),
    )
    return wid


def stop_terminal(conn, terminal_id, status):
    """故障停车:状态非 normal 后立即停止发票。"""
    conn.execute("UPDATE terminals SET status=? WHERE id=?", (status, terminal_id))


# ---------------------------------------------------------------------------
# 终端
# ---------------------------------------------------------------------------

def create_terminal(conn, tid, name, location, x, y, batch=None):
    conn.execute(
        """INSERT INTO terminals(id,name,location,map_x,map_y,online,status,
               paper_remaining,paper_capacity,last_heartbeat)
           VALUES(?,?,?,?,?,1,'normal',0,0,?)""",
        (tid, name, location, x, y, now()),
    )
    if batch is not None:
        install_batch(conn, tid, batch)


def list_terminals(conn):
    return rows_to_dicts(
        conn.execute("SELECT * FROM terminals ORDER BY id").fetchall()
    )


def heartbeat(conn, terminal_id, online=True):
    t = _term(conn, terminal_id)
    conn.execute("UPDATE terminals SET online=?, last_heartbeat=? WHERE id=?",
                 (1 if online else 0, now(), terminal_id))
    if online and t["status"] == "offline":
        # 恢复在线,自动补传离线事件
        conn.execute("UPDATE terminals SET status='normal' WHERE id=? AND status='offline'",
                     (terminal_id,))
        sync_spool(conn, terminal_id)


def mark_offline(conn, terminal_id):
    _txn(conn)
    try:
        t = _term(conn, terminal_id)
        conn.execute("UPDATE terminals SET online=0, status='offline' WHERE id=?",
                     (terminal_id,))
        wid = open_work_order(conn, terminal_id, "offline",
                              "设备心跳丢失,已离线(停止出票)")
        enqueue_review(conn, "offline", "work_order", wid, terminal_id,
                       f"终端 {t['name']} 离线,离线期间事件待补传")
        conn.commit()
        return wid
    except Exception:
        conn.rollback()
        raise


def mark_online(conn, terminal_id):
    heartbeat(conn, terminal_id, True)


# ---------------------------------------------------------------------------
# 纸卷批次
# ---------------------------------------------------------------------------

def receive_batch(conn, supplier, ticket_count, segment_start, segment_end,
                  reversed_=False):
    bid = new_id("roll")
    if segment_end - segment_start + 1 != ticket_count:
        raise ValueError("号段容量与纸卷票数不一致")
    conn.execute(
        """INSERT INTO paper_roll_batches(id,supplier,ticket_count,remaining_count,
              segment_start,segment_end,status,reversed,received_at)
           VALUES(?,?,?,?,?,?,'in_stock',?,?)""",
        (bid, supplier, ticket_count, ticket_count, segment_start, segment_end,
         1 if reversed_ else 0, now()),
    )
    return bid


def list_batches(conn):
    return rows_to_dicts(
        conn.execute("SELECT * FROM paper_roll_batches ORDER BY received_at").fetchall()
    )


def install_batch(conn, terminal_id, batch_id, old_batch_used_up=True):
    """把在库纸卷装入终端并挂载新号段。调用方需已持事务。"""
    b = conn.execute("SELECT * FROM paper_roll_batches WHERE id=?", (batch_id,)).fetchone()
    if not b:
        raise ValueError("纸卷批次不存在")
    b = dict(b)
    if b["status"] != "in_stock":
        raise ValueError(f"纸卷 {batch_id} 不在库({b['status']})")
    if b["reversed"]:
        raise ValueError("倒装纸卷不能装机")

    t = _term(conn, terminal_id)
    # 旧号段退役,旧卷用完或退库
    if t["current_batch_id"]:
        conn.execute(
            "UPDATE ticket_segments SET status='retired', retired_at=? WHERE id IN "
            "(SELECT id FROM ticket_segments WHERE terminal_id=? AND status='active')",
            (now(), terminal_id),
        )
        if old_batch_used_up:
            conn.execute(
                "UPDATE paper_roll_batches SET status='used_up', remaining_count=0, "
                "installed_terminal=? WHERE id=?",
                (terminal_id, t["current_batch_id"]),
            )

    conn.execute(
        """INSERT INTO ticket_segments(terminal_id,batch_id,start_no,end_no,next_no,
              status,mounted_at) VALUES(?,?,?,?,?,'active',?)""",
        (terminal_id, batch_id, b["segment_start"], b["segment_end"],
         b["segment_start"], now()),
    )
    conn.execute(
        """UPDATE terminals SET paper_remaining=?, paper_capacity=?,
               current_batch_id=?, seg_start=?, seg_end=?, seg_next=?,
               status='normal', last_replenished_at=? WHERE id=?""",
        (b["ticket_count"], b["ticket_count"], batch_id,
         b["segment_start"], b["segment_end"], b["segment_start"], now(), terminal_id),
    )
    conn.execute(
        "UPDATE paper_roll_batches SET status='installed', remaining_count=?, "
        "installed_terminal=? WHERE id=?",
        (b["ticket_count"], terminal_id, batch_id),
    )


# ---------------------------------------------------------------------------
# 订单与出票(核心交易)
# ---------------------------------------------------------------------------

def buy_ticket(conn, terminal_id, amount_fen, idem_key=None, ticket_kind="单程票"):
    """扣款并出票。

    幂等:同一 idem_key 重放返回原订单,绝不二次扣款/出票。
    停车规则:终端离线或 status != normal 时不出票。
    打印机故障(卡纸/断纸/倒装)时不消耗号段,转复核队列。
    """
    idem_key = idem_key or new_id("idem")
    _txn(conn)
    try:
        # 1) 幂等重放
        existed = conn.execute(
            "SELECT * FROM payment_orders WHERE idem_key=?", (idem_key,)
        ).fetchone()
        if existed:
            conn.commit()
            return dict(existed), {"replayed": True}

        t = _term(conn, terminal_id)
        order_no = new_id("ord")
        conn.execute(
            """INSERT INTO payment_orders(order_no,idem_key,terminal_id,amount_fen,
                  status,created_at) VALUES(?,?,?,?,'paying',?)""",
            (order_no, idem_key, terminal_id, amount_fen, now()),
        )

        # 2) 支付(进程内模拟,自身幂等)
        pay = payment.pay(idem_key, amount_fen, order_no)
        if not pay.get("ok"):
            detail = "支付失败" + (":扣款状态未知" if pay.get("uncertain") else "")
            conn.execute("UPDATE payment_orders SET status='failed' WHERE order_no=?",
                         (order_no,))
            if pay.get("uncertain"):
                wid = open_work_order(conn, terminal_id, "payment_no_ticket",
                                      f"订单 {order_no} 扣款状态未知,未出票", order_no)
                enqueue_review(conn, "payment_no_ticket", "order", order_no,
                               terminal_id, f"支付网关超时,需对账;工单号 {wid}")
            conn.commit()
            return _order(conn, order_no), {"replayed": False, "pay_error": pay["error"]}

        conn.execute("UPDATE payment_orders SET status='paid', paid_at=? WHERE order_no=?",
                     (now(), order_no))

        # 3) 出票前闸门:离线 / 故障停车一律不打
        t = _term(conn, terminal_id)
        gate = _issuance_gate(t)
        if gate:
            _park_paid_order(conn, t, order_no, gate)
            conn.commit()
            return _order(conn, order_no), {"replayed": False, "blocked": gate}

        next_no = t["seg_next"]
        ticket_no = fmt_ticket(next_no)

        # 4) 物理打印(模拟)。失败不占号。
        reversed_paper = False
        batch = conn.execute("SELECT reversed FROM paper_roll_batches WHERE id=?",
                             (t["current_batch_id"],)).fetchone()
        if batch and batch["reversed"]:
            reversed_paper = True
        try:
            printer.print_ticket(terminal_id, ticket_no, order_no, reversed_paper)
        except adapters.PrinterError as e:
            _handle_printer_fault(conn, t, order_no, e.reason)
            conn.commit()
            return _order(conn, order_no), {"replayed": False, "blocked": e.reason}

        # 5) 打印成功:原子扣纸 + 推进号段
        cur = conn.execute(
            "SELECT paper_remaining, seg_next, seg_end FROM terminals WHERE id=?",
            (terminal_id,),
        ).fetchone()
        if cur["paper_remaining"] <= 0 or cur["seg_next"] > cur["seg_end"]:
            # 极端并发兜底:事务内双重检查
            _park_paid_order(conn, t, order_no, "no_paper")
            conn.commit()
            return _order(conn, order_no), {"replayed": False, "blocked": "no_paper"}

        conn.execute(
            """UPDATE terminals SET paper_remaining=paper_remaining-1,
                   seg_next=seg_next+1 WHERE id=?""",
            (terminal_id,),
        )
        if batch:
            conn.execute(
                "UPDATE paper_roll_batches SET remaining_count=remaining_count-1 WHERE id=?",
                (t["current_batch_id"],),
            )
        conn.execute(
            """INSERT INTO ticket_issues(ticket_no,order_no,terminal_id,segment_id,
                  issued_at,flag)
               SELECT ?,?,?,id,?,'ok' FROM ticket_segments
               WHERE terminal_id=? AND status='active'""",
            (ticket_no, order_no, terminal_id, now(), terminal_id),
        )
        conn.execute(
            "UPDATE payment_orders SET status='ticketed', ticket_no=? WHERE order_no=?",
            (ticket_no, order_no),
        )
        _emit_receipt(conn, terminal_id, "ticket_issued",
                      {"order_no": order_no, "ticket_no": ticket_no,
                       "amount_fen": amount_fen})

        # 6) 号段打尽:立即停车,不允许跳号续打
        after = _term(conn, terminal_id)
        if after["seg_next"] > after["seg_end"] or after["paper_remaining"] == 0:
            conn.execute(
                "UPDATE ticket_segments SET status='exhausted', retired_at=? "
                "WHERE terminal_id=? AND status='active'",
                (now(), terminal_id),
            )
            stop_terminal(conn, terminal_id, "no_paper")
            wid = open_work_order(conn, terminal_id, "no_paper",
                                  f"号段 {after['seg_start']}-{after['seg_end']} 已用尽,等待换卷")
            enqueue_review(conn, "payment_no_ticket", "work_order", wid, terminal_id,
                           "号段用尽,后续扣款订单将无法出票")

        # 7) 模拟重复出票(打印机硬件重打同一张)
        #    通过外部开关注入;发生后立即停车并转复核。
        from .adapters import _printer_state
        st = _printer_state.get(terminal_id, {})
        if st.get("force_dup"):
            _printer_state[terminal_id]["force_dup"] = False
            conn.execute(
                """INSERT INTO ticket_issues(ticket_no,order_no,terminal_id,segment_id,
                      issued_at,flag,duplicate_of)
                   SELECT ?,?,?,ts.id,?,'duplicate',ti.ticket_no FROM ticket_issues ti
                   JOIN ticket_segments ts ON ts.terminal_id=? AND ts.status='active'
                   WHERE ti.order_no=? AND ti.flag='ok'""",
                (ticket_no, order_no, terminal_id, now(), terminal_id, order_no),
            )
            stop_terminal(conn, terminal_id, "jam")
            wid = open_work_order(
                conn, terminal_id, "dup_issue",
                f"票号 {ticket_no} 被重复打印,原订单 {order_no}", order_no)
            enqueue_review(conn, "dup_issue", "work_order", wid, terminal_id,
                           f"重复票号 {ticket_no},首张保留、重张待核销")

        conn.commit()
        return _order(conn, order_no), {"replayed": False, "ticket_no": ticket_no}
    except Exception:
        conn.rollback()
        raise


def _issuance_gate(t):
    if not t["online"] or t["status"] == "offline":
        return "offline"
    if t["status"] != "normal":
        return t["status"]
    if not t["current_batch_id"]:
        return "no_paper"
    if t["paper_remaining"] <= 0 or t["seg_next"] > t["seg_end"]:
        return "no_paper"
    return None


def _park_paid_order(conn, t, order_no, reason):
    """已扣款未出票:挂单 + 工单 + 复核。"""
    kind = {"no_paper": "no_paper", "offline": "offline"}.get(reason, "payment_no_ticket")
    wo_kind = "payment_no_ticket" if reason in ("no_paper", "jam", "roll_reversed") else reason
    wid = open_work_order(conn, t["id"], wo_kind,
                          f"订单 {order_no} 已扣款未出票({reason})", order_no)
    enqueue_review(conn, "payment_no_ticket", "order", order_no, t["id"],
                   f"扣款成功未出票,原因 {reason};工单 {wid}")
    stop_terminal(conn, t["id"], "no_paper" if reason == "no_paper" else
                  ("offline" if reason == "offline" else t["status"]))


def _handle_printer_fault(conn, t, order_no, reason):
    if reason == "jam":
        stop_terminal(conn, t["id"], "jam")
        wid = open_work_order(conn, t["id"], "jam",
                              f"卡纸,订单 {order_no} 已扣款未出票,票号未消耗", order_no)
        enqueue_review(conn, "payment_no_ticket", "order", order_no, t["id"],
                       f"卡纸停车,票号未跳号;工单 {wid}")
    elif reason == "paper_out":
        stop_terminal(conn, t["id"], "no_paper")
        wid = open_work_order(conn, t["id"], "no_paper",
                              f"断纸,订单 {order_no} 已扣款未出票", order_no)
        enqueue_review(conn, "payment_no_ticket", "order", order_no, t["id"],
                       f"断纸停车;工单 {wid}")
    elif reason == "roll_reversed":
        stop_terminal(conn, t["id"], "jam")
        wid = open_work_order(conn, t["id"], "roll_reversed",
                              f"纸卷倒装自检失败,订单 {order_no} 未出票", order_no)
        enqueue_review(conn, "roll_reversed", "work_order", wid, t["id"],
                       "纸卷倒装,需更换正确方向纸卷")


def _order(conn, order_no):
    return dict(conn.execute("SELECT * FROM payment_orders WHERE order_no=?",
                             (order_no,)).fetchone())


def list_orders(conn, limit=200):
    return rows_to_dicts(
        conn.execute("SELECT * FROM payment_orders ORDER BY id DESC LIMIT ?",
                     (limit,)).fetchall()
    )


def _emit_receipt(conn, terminal_id, kind, payload, event_id=None, synced=1):
    event_id = event_id or new_id("evt")
    path = write_device_receipt(terminal_id, event_id, kind, payload)
    conn.execute(
        """INSERT INTO device_receipts(event_id,terminal_id,kind,file_path,created_at,synced)
           VALUES(?,?,?,?,?,?)""",
        (event_id, terminal_id, kind, path, now(), synced),
    )
    return event_id, path


# ---------------------------------------------------------------------------
# 人工补票(必须挂故障工单)
# ---------------------------------------------------------------------------

def manual_issue(conn, work_order_id, operator_role):
    if operator_role != "supervisor":
        raise PermissionError("仅主管可人工补票")
    _txn(conn)
    try:
        wo = conn.execute("SELECT * FROM fault_work_orders WHERE id=?",
                          (work_order_id,)).fetchone()
        if not wo:
            raise ValueError("工单不存在")
        wo = dict(wo)
        if wo["status"] == "resolved":
            raise ValueError("工单已结案")
        if not wo["related_order"]:
            raise ValueError("该工单无关联订单,不能补票")
        order = _order(conn, wo["related_order"])
        if order["status"] == "ticketed":
            raise ValueError("订单已出票,禁止重复补票")
        t = _term(conn, wo["terminal_id"])
        if t["paper_remaining"] <= 0 or t["seg_next"] > t["seg_end"]:
            raise ValueError("终端无可用号段,请先补给换卷")
        ticket_no = fmt_ticket(t["seg_next"])
        conn.execute(
            """INSERT INTO ticket_issues(ticket_no,order_no,terminal_id,segment_id,
                  issued_at,flag,work_order)
               SELECT ?,?,?,id,?,'manual',? FROM ticket_segments
               WHERE terminal_id=? AND status='active'""",
            (ticket_no, order["order_no"], t["id"], now(), work_order_id, t["id"]),
        )
        conn.execute("UPDATE terminals SET paper_remaining=paper_remaining-1, "
                     "seg_next=seg_next+1 WHERE id=?", (t["id"],))
        conn.execute(
            "UPDATE payment_orders SET status='ticketed', ticket_no=? WHERE order_no=?",
            (ticket_no, order["order_no"]),
        )
        conn.execute(
            "UPDATE fault_work_orders SET status='resolved', resolution=?, "
            "manual_ticket_no=?, resolved_at=? WHERE id=?",
            (f"人工补票 {ticket_no}", ticket_no, now(), work_order_id),
        )
        conn.execute(
            """UPDATE review_queue SET status='resolved', resolved_at=?, resolution=?
               WHERE ref_type='order' AND ref_id=? AND status IN ('pending','reviewing')""",
            (now(), f"已人工补票 {ticket_no}", order["order_no"]),
        )
        _emit_receipt(conn, t["id"], "manual_ticket",
                      {"order_no": order["order_no"], "ticket_no": ticket_no,
                       "work_order": work_order_id})
        # 主管现场补票视为故障已处置,终端恢复售票(纸尽状态除外)
        if t["paper_remaining"] - 1 > 0:
            conn.execute("UPDATE terminals SET status='normal' WHERE id=? AND status!='offline'",
                         (t["id"],))
        conn.commit()
        return ticket_no
    except Exception:
        conn.rollback()
        raise


def resolve_work_order(conn, work_order_id, resolution, operator_role):
    if operator_role not in ("supervisor", "replenisher"):
        raise PermissionError("无工单处理权限")
    _txn(conn)
    try:
        wo = conn.execute("SELECT * FROM fault_work_orders WHERE id=?",
                          (work_order_id,)).fetchone()
        if not wo:
            raise ValueError("工单不存在")
        conn.execute(
            "UPDATE fault_work_orders SET status='resolved', resolution=?, "
            "resolved_at=?, assignee=COALESCE(assignee,?) WHERE id=?",
            (resolution, now(), operator_role, work_order_id),
        )
        # 普通故障处理完恢复 normal(离线由心跳恢复、缺纸由换卷恢复)
        conn.execute(
            "UPDATE terminals SET status='normal' WHERE id=? AND status IN ('jam')",
            (wo["terminal_id"],),
        )
        conn.execute(
            """UPDATE review_queue SET status='resolved', resolved_at=?, resolution=?
               WHERE ref_id=? AND status IN ('pending','reviewing')""",
            (now(), resolution, work_order_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def list_work_orders(conn):
    return rows_to_dicts(
        conn.execute("SELECT * FROM fault_work_orders ORDER BY "
                     "status='resolved', created_at DESC").fetchall()
    )


def list_review_queue(conn):
    return rows_to_dicts(
        conn.execute("SELECT * FROM review_queue ORDER BY status='resolved' DESC, id DESC")
        .fetchall()
    )


def resolve_review(conn, review_id, resolution, operator_role):
    if operator_role not in ("supervisor", "finance"):
        raise PermissionError("仅主管/财务可核销复核项")
    conn.execute(
        "UPDATE review_queue SET status='resolved', resolved_at=?, resolution=? WHERE id=?",
        (now(), resolution, review_id),
    )


# ---------------------------------------------------------------------------
# 补给任务:扫码开柜 + 双人抢单唯一锁定 + 计数器照片
# ---------------------------------------------------------------------------

def create_replenish_task(conn, terminal_id, note=""):
    tid = new_id("task")
    conn.execute(
        """INSERT INTO replenish_tasks(id,terminal_id,status,scan_code,note,created_at)
           VALUES(?,?,'pending',?,?,?)""",
        (tid, terminal_id, new_id("scan"), note, now()),
    )
    return tid


def claim_task(conn, task_id, user_id, scan_code):
    """两名补给员同时领取时只保留一个锁定者(条件更新原子判定)。"""
    if not scan_code:
        raise ValueError("请先扫描柜体二维码开柜")
    _txn(conn)
    try:
        task = conn.execute("SELECT * FROM replenish_tasks WHERE id=?",
                            (task_id,)).fetchone()
        if not task:
            raise ValueError("任务不存在")
        task = dict(task)
        if task["scan_code"] != scan_code:
            raise ValueError("扫码凭证与任务不匹配,禁止开柜")
        cur = conn.execute(
            """UPDATE replenish_tasks SET status='locked', locked_by=?, locked_at=?
               WHERE id=? AND status='pending'""",
            (user_id, now(), task_id),
        )
        conn.commit()
        if cur.rowcount == 1:
            return {"won": True, "locked_by": user_id}
        return {"won": False, "locked_by": task["locked_by"] or "他人"}
    except Exception:
        conn.rollback()
        raise


def _write_counter_photo(terminal_id, task_id, label, counter):
    """模拟计数器照片:生成一张本地 SVG,印着计数器读数。"""
    from . import config
    os.makedirs(config.PHOTO_DIR, exist_ok=True)
    fname = f"{task_id}_{label[0]}.svg"  # before/after
    path = os.path.join(config.PHOTO_DIR, fname)
    caption = "换卷前" if label[0] == "b" else "换卷后"
    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='240' height='120'>
<rect width='240' height='120' fill='#1f2746'/>
<rect x='8' y='8' width='224' height='104' fill='#0e1330' stroke='#ffd400' stroke-width='2'/>
<text x='120' y='46' text-anchor='middle' fill='#ffd400'
 font-family='monospace' font-size='15'>{caption} 计数器</text>
<text x='120' y='92' text-anchor='middle' fill='#ffffff'
 font-family='monospace' font-size='34'>{counter:08d}</text>
</svg>
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    return path


def complete_task(conn, task_id, user_id, new_batch_id, counter_before, counter_after):
    """换卷完成。前后计数器照片缺一不可;倒装卷进入复核队列。"""
    _txn(conn)
    try:
        task = conn.execute("SELECT * FROM replenish_tasks WHERE id=?",
                            (task_id,)).fetchone()
        if not task:
            raise ValueError("任务不存在")
        task = dict(task)
        if task["status"] != "locked":
            raise ValueError("任务未处于锁定状态")
        if task["locked_by"] != user_id:
            raise PermissionError(f"任务由 {task['locked_by']} 锁定")
        if counter_before is None or counter_after is None:
            raise ValueError("缺少换卷前后计数器读数")

        b = conn.execute("SELECT * FROM paper_roll_batches WHERE id=?",
                         (new_batch_id,)).fetchone()
        if not b:
            raise ValueError("纸卷批次不存在")
        b = dict(b)
        if b["reversed"]:
            # 倒装:拒绝装机,进入复核队列
            stop_terminal(conn, task["terminal_id"], "jam")
            wid = open_work_order(conn, task["terminal_id"], "roll_reversed",
                                  f"补给任务 {task_id} 检测到倒装纸卷 {new_batch_id}")
            enqueue_review(conn, "roll_reversed", "work_order", wid,
                           task["terminal_id"],
                           f"补给员 {user_id} 装入倒装卷,已阻止开机")
            conn.commit()
            raise ValueError("检测到倒装纸卷,已停止装机并转入复核")
        if b["status"] != "in_stock":
            raise ValueError("该纸卷不在库")

        photo_before = _write_counter_photo(
            task["terminal_id"], task_id, "before", counter_before)
        install_batch(conn, task["terminal_id"], new_batch_id)
        photo_after = _write_counter_photo(
            task["terminal_id"], task_id, "after", counter_after)

        conn.execute(
            """UPDATE replenish_tasks SET status='done', completed_by=?, completed_at=?,
                   old_batch_id=COALESCE(old_batch_id,?), new_batch_id=?,
                   counter_before=?, counter_after=?, photo_before=?, photo_after=?
               WHERE id=?""",
            (user_id, now(), task["old_batch_id"], new_batch_id,
             counter_before, counter_after, photo_before, photo_after, task_id),
        )
        _emit_receipt(conn, task["terminal_id"], "roll_replaced",
                      {"task_id": task_id, "new_batch": new_batch_id,
                       "counter_before": counter_before, "counter_after": counter_after})
        conn.execute(
            """UPDATE fault_work_orders SET status='resolved', resolution=?,
                   resolved_at=? WHERE terminal_id=? AND kind IN ('no_paper','jam')
                   AND status!='resolved'""",
            (f"换卷完成,任务 {task_id}", now(), task["terminal_id"]),
        )
        conn.execute(
            """UPDATE review_queue SET status='resolved', resolved_at=?, resolution=?
               WHERE terminal_id=? AND kind IN ('payment_no_ticket','roll_reversed')
               AND status IN ('pending','reviewing')""",
            (now(), "换卷完成", task["terminal_id"]),
        )
        conn.commit()
        return {"photo_before": photo_before, "photo_after": photo_after}
    except Exception:
        conn.rollback()
        raise


def list_tasks(conn):
    return rows_to_dicts(
        conn.execute("SELECT * FROM replenish_tasks ORDER BY created_at DESC").fetchall()
    )


# ---------------------------------------------------------------------------
# 补给路线
# ---------------------------------------------------------------------------

def create_route(conn, name, task_ids):
    rid = new_id("route")
    conn.execute(
        "INSERT INTO replenish_routes(id,name,task_ids,status,created_at) "
        "VALUES(?,?,?, 'planned',?)",
        (rid, name, json.dumps(task_ids, ensure_ascii=False), now()),
    )
    return rid


def list_routes(conn):
    out = []
    for r in conn.execute("SELECT * FROM replenish_routes ORDER BY created_at").fetchall():
        d = dict(r)
        d["task_ids"] = json.loads(d["task_ids"])
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# 退款
# ---------------------------------------------------------------------------

def apply_refund(conn, order_no, applicant, reason):
    """一张原订单只允许一次退款(DB UNIQUE + 状态双检)。"""
    _txn(conn)
    try:
        order = _order(conn, order_no)
        if order["status"] not in ("paid", "ticketed"):
            raise ValueError(f"订单状态 {order['status']} 不允许退款")
        dup = conn.execute("SELECT id FROM refunds WHERE order_no=?", (order_no,)).fetchone()
        if dup:
            raise ValueError("该订单已存在退款单,禁止重复退款")
        rid = new_id("ref")
        conn.execute(
            """INSERT INTO refunds(id,order_no,amount_fen,status,applicant,reason,created_at)
               VALUES(?,?,?, 'pending',?,?,?)""",
            (rid, order_no, order["amount_fen"], applicant, reason, now()),
        )
        conn.execute("UPDATE payment_orders SET status='refunding' WHERE order_no=?",
                     (order_no,))
        conn.commit()
        return rid
    except Exception:
        conn.rollback()
        raise


def decide_refund(conn, refund_id, action, operator_role, note=""):
    """审批权限:仅财务可退款出款;主管可驳回。"""
    _txn(conn)
    try:
        r = conn.execute("SELECT * FROM refunds WHERE id=?", (refund_id,)).fetchone()
        if not r:
            raise ValueError("退款单不存在")
        r = dict(r)
        if r["status"] != "pending":
            raise ValueError(f"退款单已 {r['status']}")
        if action == "approve":
            if operator_role != "finance":
                raise PermissionError("仅财务角色可批准退款")
            res = payment.refund(r["order_no"], r["amount_fen"])
            conn.execute(
                """UPDATE refunds SET status='refunded', decision=?, decided_by=?,
                       decided_at=?, refunded_at=? WHERE id=?""",
                (note or "同意退款", operator_role, now(), now(), refund_id),
            )
            conn.execute("UPDATE payment_orders SET status='refunded' WHERE order_no=?",
                         (r["order_no"],))
            _emit_receipt(conn,
                          conn.execute("SELECT terminal_id FROM payment_orders WHERE order_no=?",
                                       (r["order_no"],)).fetchone()["terminal_id"],
                          "refund_done",
                          {"order_no": r["order_no"], "refund_id": refund_id,
                           "amount_fen": r["amount_fen"], "gateway": res})
        elif action == "reject":
            if operator_role not in ("finance", "supervisor"):
                raise PermissionError("仅财务/主管可驳回退款")
            conn.execute(
                """UPDATE refunds SET status='rejected', decision=?, decided_by=?,
                       decided_at=? WHERE id=?""",
                (note or "驳回", operator_role, now(), refund_id),
            )
            conn.execute(
                "UPDATE payment_orders SET status=CASE WHEN ticket_no IS NOT NULL "
                "THEN 'ticketed' ELSE 'paid' END WHERE order_no=?",
                (r["order_no"],),
            )
        else:
            raise ValueError("未知审批动作")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def timeout_refunds(conn, older_than_seconds=300):
    """超时未审批的退款单转超时复核队列。"""
    cutoff = time.time() - older_than_seconds
    pending = conn.execute("SELECT * FROM refunds WHERE status='pending'").fetchall()
    n = 0
    for r in pending:
        created = time.mktime(time.strptime(r["created_at"], "%Y-%m-%d %H:%M:%S"))
        if created <= cutoff:
            _txn(conn)
            try:
                conn.execute("UPDATE refunds SET status='timeout', decision='审批超时' WHERE id=?",
                             (r["id"],))
                t = conn.execute("SELECT terminal_id FROM payment_orders WHERE order_no=?",
                                 (r["order_no"],)).fetchone()["terminal_id"]
                wid = open_work_order(conn, t, "refund_timeout",
                                      f"退款单 {r['id']} 审批超时,原订单 {r['order_no']}",
                                      r["order_no"])
                enqueue_review(conn, "refund_timeout", "refund", r["id"], t,
                               f"退款超时未审批,金额 {r['amount_fen']} 分;工单 {wid}")
                conn.commit()
                n += 1
            except Exception:
                conn.rollback()
                raise
    return n


def list_refunds(conn):
    return rows_to_dicts(
        conn.execute("SELECT * FROM refunds ORDER BY id DESC").fetchall()
    )


def evidence_chain(conn, order_no):
    """退款证据链:原订单 -> 设备回执 -> 处理动作(纵向)。"""
    order = conn.execute("SELECT * FROM payment_orders WHERE order_no=?",
                         (order_no,)).fetchone()
    if not order:
        raise ValueError("订单不存在")
    receipts = rows_to_dicts(conn.execute(
        "SELECT * FROM device_receipts WHERE terminal_id=? ORDER BY id",
        (order["terminal_id"],)).fetchall())
    related = []
    for r in receipts:
        with open(r["file_path"], encoding="utf-8") as f:
            r["body"] = json.load(f)
        payload = r["body"].get("payload", {})
        if payload.get("order_no") == order_no or payload.get("ticket_no") == order["ticket_no"]:
            related.append(r)
    refunds = rows_to_dicts(conn.execute(
        "SELECT * FROM refunds WHERE order_no=?", (order_no,)).fetchall())
    wos = rows_to_dicts(conn.execute(
        "SELECT * FROM fault_work_orders WHERE related_order=?", (order_no,)).fetchall())
    term = dict(conn.execute("SELECT * FROM terminals WHERE id=?",
                             (order["terminal_id"],)).fetchone())
    return {"order": dict(order), "terminal": term, "receipts": related,
            "refunds": refunds, "work_orders": wos}


# ---------------------------------------------------------------------------
# 离线事件:本地暂存 + 恢复后补传(去重)
# ---------------------------------------------------------------------------

def spool_event(conn, terminal_id, kind, payload, event_id=None):
    """离线期间事件只落本地(回执文件 + spool 表),不改动票号状态。"""
    event_id = event_id or new_id("evt")
    _txn(conn)
    try:
        exists = conn.execute("SELECT 1 FROM event_spool WHERE event_id=?",
                              (event_id,)).fetchone()
        if exists:
            conn.commit()
            return event_id, True
        path = write_device_receipt(terminal_id, event_id, kind, payload)
        conn.execute(
            """INSERT INTO event_spool(terminal_id,event_id,kind,payload,created_at,status)
               VALUES(?,?,?,?,?, 'pending')""",
            (terminal_id, event_id, kind,
             json.dumps(payload, ensure_ascii=False), now()),
        )
        conn.execute(
            "INSERT OR IGNORE INTO device_receipts(event_id,terminal_id,kind,file_path,"
            "created_at,synced) VALUES(?,?,?,?,?,0)",
            (event_id, terminal_id, kind, path, now()),
        )
        conn.commit()
        return event_id, False
    except Exception:
        conn.rollback()
        raise


def _apply_spooled_event(conn, ev):
    """把补传事件折算成平台状态(心跳/故障/销售尝试)。"""
    payload = json.loads(ev["payload"])
    kind = ev["kind"]
    if kind == "jam_reported":
        # 离线期间上报的卡纸:开工单留痕,不重复进复核队列
        t = conn.execute("SELECT status FROM terminals WHERE id=?",
                         (ev["terminal_id"],)).fetchone()
        if t and t["status"] == "normal":
            stop_terminal(conn, ev["terminal_id"], "jam")
        exists_wo = conn.execute(
            "SELECT 1 FROM fault_work_orders WHERE terminal_id=? AND kind='jam' "
            "AND status!='resolved'", (ev["terminal_id"],)).fetchone()
        if not exists_wo:
            open_work_order(conn, ev["terminal_id"], "jam", "离线期间上报卡纸(补传)")
    elif kind == "sale_attempt":
        # 离线期间乘客已被扣款(模拟)但无法出票
        order_no = payload.get("order_no")
        if order_no and not conn.execute("SELECT 1 FROM payment_orders WHERE order_no=?",
                                         (order_no,)).fetchone():
            conn.execute(
                """INSERT INTO payment_orders(order_no,idem_key,terminal_id,amount_fen,
                      status,created_at,paid_at)
                   VALUES(?,?,?,?,'paid',?,?)""",
                (order_no, new_id("idem"), ev["terminal_id"],
                 payload["amount_fen"], ev["created_at"], ev["created_at"]),
            )
            wid = open_work_order(conn, ev["terminal_id"], "payment_no_ticket",
                                  f"离线段扣款订单 {order_no} 补传,未出票", order_no)
            enqueue_review(conn, "payment_no_ticket", "order", order_no,
                           ev["terminal_id"], f"离线补传:已扣款未出票;工单 {wid}")
    # heartbeat/offline 等事件仅留痕,不改状态


def sync_spool(conn, terminal_id):
    """按顺序补传,event_id 去重;重复调用安全。"""
    _txn(conn)
    try:
        evs = conn.execute(
            "SELECT * FROM event_spool WHERE terminal_id=? AND status='pending' ORDER BY id",
            (terminal_id,)).fetchall()
        applied = 0
        for ev in evs:
            _apply_spooled_event(conn, ev)
            conn.execute(
                "UPDATE event_spool SET status='synced', synced_at=? WHERE id=?",
                (now(), ev["id"]),
            )
            conn.execute(
                "UPDATE device_receipts SET synced=1 WHERE event_id=?", (ev["event_id"],))
            applied += 1
        conn.commit()
        return {"applied": applied}
    except Exception:
        conn.rollback()
        raise
