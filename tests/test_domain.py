"""测试:号段连续、订单幂等、纸卷并发扣减、离线补传、退款权限。

每个用例使用独立临时数据目录 + 全新 SQLite,进程内模拟适配器状态也被重置。
运行: ./run.sh test  或  python -m unittest discover -s tests
"""
import importlib
import json
import os
import shutil
import tempfile
import threading
import unittest


def _fresh_env():
    """为每个用例重建独立数据目录并重载配置。"""
    tmp = tempfile.mkdtemp(prefix="tvm_test_")
    os.environ["TVM_DATA_DIR"] = tmp
    from app import config
    importlib.reload(config)
    from app import adapters
    importlib.reload(adapters)
    from app import database, services
    importlib.reload(database)
    importlib.reload(services)
    return tmp, config, adapters, database, services


class CaseBase(unittest.TestCase):
    def setUp(self):
        self.tmp, self.config, self.adapters, self.database, self.svc = _fresh_env()
        self.conn = self.database.connect()
        self.database.init_db(self.conn)
        self._bootstrap()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- 构造一台装了小容量纸卷的终端 --
    def _bootstrap(self, terminal="TVM_T", count=200, start=10_001):
        s = self.svc
        s.create_terminal(self.conn, terminal, "测试站", "测试位置", 50, 50)
        self.batch = s.receive_batch(
            self.conn, "测试纸厂", count, start, start + count - 1)
        s.install_batch(self.conn, terminal, self.batch)
        self.terminal = terminal
        self.start = start
        self.count = count

    def buy(self, idem=None, amount=500, terminal=None):
        return self.svc.buy_ticket(
            self.conn, terminal or self.terminal, amount, idem_key=idem)


# ---------------------------------------------------------------------------
# 1) 票据号段连续性:连续不跳号;卡纸/缺纸不耗号;号段尽立即停车
# ---------------------------------------------------------------------------
class SegmentContinuityTest(CaseBase):

    def test_sequential_numbers(self):
        nums = []
        for _ in range(5):
            order, info = self.buy(f"k-{len(nums)}")
            nums.append(int(info["ticket_no"][1:]))
        self.assertEqual(nums, [self.start + i for i in range(5)])

    def test_jam_does_not_skip_number(self):
        before = self.conn.execute(
            "SELECT seg_next FROM terminals WHERE id=?", (self.terminal,)).fetchone()[0]
        self.adapters.set_jam(self.terminal, True)
        order, info = self.buy("jam-1")
        self.assertEqual(info.get("blocked"), "jam")
        self.assertEqual(order["status"], "paid")  # 扣款成功但未出票
        after = self.conn.execute(
            "SELECT seg_next FROM terminals WHERE id=?", (self.terminal,)).fetchone()[0]
        self.assertEqual(before, after, "卡纸不得消耗票号")

        # 解除卡纸前,出票前闸门继续拦截,仍然不耗号
        order2, info2 = self.buy("jam-2")
        self.assertEqual(info2.get("blocked"), "jam")
        after2 = self.conn.execute(
            "SELECT seg_next FROM terminals WHERE id=?", (self.terminal,)).fetchone()[0]
        self.assertEqual(before, after2)

        # 工单结案 + 故障清除后,下一张票仍是原号,没有跳号
        self.svc.resolve_work_order(
            self.conn,
            self.conn.execute(
                "SELECT id FROM fault_work_orders WHERE terminal_id=? ORDER BY id LIMIT 1",
                (self.terminal,)).fetchone()[0],
            "清卡纸", "supervisor")
        self.adapters.reset_faults(self.terminal)
        order3, info3 = self.buy("jam-3")
        self.assertEqual(info3["ticket_no"], f"T{before:08d}")

    def test_segment_exhaustion_stops_issuance(self):
        # 把号段缩到只剩 2 张
        self.conn.execute(
            "UPDATE terminals SET paper_remaining=2, seg_next=? WHERE id=?",
            (self.start + self.count - 2, self.terminal))
        o1, i1 = self.buy("last-1")
        o2, i2 = self.buy("last-2")
        self.assertTrue(i1["ticket_no"] and i2["ticket_no"])
        self.assertEqual(int(i2["ticket_no"][1:]), self.start + self.count - 1)

        # 第 3 笔:扣款成功但无纸可打,停车进复核,绝不能跳到下一卷号段
        o3, i3 = self.buy("overflow")
        self.assertEqual(i3.get("blocked"), "no_paper")
        t = self.conn.execute("SELECT * FROM terminals WHERE id=?",
                              (self.terminal,)).fetchone()
        self.assertEqual(t["status"], "no_paper")
        self.assertEqual(t["seg_next"], self.start + self.count)
        n_review = self.conn.execute(
            "SELECT COUNT(*) c FROM review_queue WHERE kind='payment_no_ticket' "
            "AND status='pending'").fetchone()["c"]
        self.assertGreaterEqual(n_review, 1)

        # 换卷后使用新批次号段,旧号段标记 exhausted
        nb = self.svc.receive_batch(
            self.conn, "测试纸厂", 200, 20_001, 20_200)
        task = self.svc.create_replenish_task(self.conn, self.terminal)
        sc = self.conn.execute("SELECT scan_code FROM replenish_tasks WHERE id=?",
                               (task,)).fetchone()[0]
        self.svc.claim_task(self.conn, task, "u_lin", sc)
        self.svc.complete_task(self.conn, task, "u_lin", nb, 198, 200)
        o4, i4 = self.buy("after-replenish")
        self.assertEqual(i4["ticket_no"], "T00020001")

    def test_no_duplicate_valid_ticket_numbers(self):
        for i in range(10):
            self.buy(f"k-{i}")
        rows = self.conn.execute(
            "SELECT ticket_no FROM ticket_issues WHERE flag IN ('ok','manual')"
        ).fetchall()
        nos = [r["ticket_no"] for r in rows]
        self.assertEqual(len(nos), len(set(nos)))


# ---------------------------------------------------------------------------
# 2) 订单幂等:同键重放只扣一次款、只出一张票
# ---------------------------------------------------------------------------
class OrderIdempotencyTest(CaseBase):

    def test_same_idem_key_replays(self):
        o1, i1 = self.buy("same-key")
        o2, i2 = self.buy("same-key")
        self.assertFalse(i1["replayed"])
        self.assertTrue(i2["replayed"])
        self.assertEqual(o1["order_no"], o2["order_no"])
        self.assertEqual(i1["ticket_no"], i2.get("ticket_no") or o2["ticket_no"])
        charges = self.adapters.payment.charges()
        self.assertEqual(len([c for c in charges]), 1)
        n_tickets = self.conn.execute(
            "SELECT COUNT(*) c FROM ticket_issues WHERE flag='ok'").fetchone()["c"]
        self.assertEqual(n_tickets, 1)

    def test_different_keys_both_charge(self):
        self.buy("key-a")
        self.buy("key-b")
        self.assertEqual(len(self.adapters.payment.charges()), 2)


# ---------------------------------------------------------------------------
# 3) 纸卷并发扣减:多线程同时购票,不超卖、票号不重复
# ---------------------------------------------------------------------------
class ConcurrentPaperTest(CaseBase):

    def test_concurrent_deduction_no_oversell(self):
        self._bootstrap(terminal="TVM_C", count=30, start=30_001)
        results, errors = [], []
        lock = threading.Lock()

        def worker(idx):
            conn = self.database.connect()
            try:
                order, info = self.svc.buy_ticket(conn, "TVM_C", 500,
                                                  idem_key=f"c-{idx}")
                with lock:
                    results.append(info)
            except Exception as e:  # noqa: BLE001
                with lock:
                    errors.append(e)
            finally:
                conn.close()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(45)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        issued = sorted(int(r["ticket_no"][1:]) for r in results if r.get("ticket_no"))
        blocked = [r for r in results if r.get("blocked")]
        self.assertEqual(len(issued), 30, f"应恰好售出 30 张,实际 {len(issued)}")
        self.assertEqual(len(issued), len(set(issued)), "票号不得重复")
        self.assertEqual(issued, [30_001 + i for i in range(30)])
        self.assertEqual(len(blocked), 15, "超出纸量的订单必须被拦截")
        remaining = self.conn.execute(
            "SELECT paper_remaining FROM terminals WHERE id='TVM_C'").fetchone()[0]
        self.assertEqual(remaining, 0)


# ---------------------------------------------------------------------------
# 4) 离线补传:事件本地暂存,恢复后按序补传且 event_id 去重、重复同步安全
# ---------------------------------------------------------------------------
class OfflineSyncTest(CaseBase):

    def test_spool_dedup_and_sync_once(self):
        self._bootstrap(terminal="TVM_O", count=50, start=40_001)
        self.svc.mark_offline(self.conn, "TVM_O")

        # 离线期间两条事件,其中销售事件用同一 event_id 上报两次
        eid, dup1 = self.svc.spool_event(
            self.conn, "TVM_O", "sale_attempt",
            {"order_no": "ord_off_1", "amount_fen": 500}, event_id="evt-fixed-1")
        _, dup2 = self.svc.spool_event(
            self.conn, "TVM_O", "sale_attempt",
            {"order_no": "ord_off_1", "amount_fen": 500}, event_id="evt-fixed-1")
        self.svc.spool_event(self.conn, "TVM_O", "jam_reported", {"sensor": "x"})
        self.assertFalse(dup1)
        self.assertTrue(dup2, "相同 event_id 必须识别为重复")

        n_spool = self.conn.execute(
            "SELECT COUNT(*) c FROM event_spool").fetchone()["c"]
        self.assertEqual(n_spool, 2)

        # 恢复在线 → 补传:只生成一笔订单
        self.svc.mark_online(self.conn, "TVM_O")
        n_orders = self.conn.execute(
            "SELECT COUNT(*) c FROM payment_orders WHERE order_no='ord_off_1'"
        ).fetchone()["c"]
        self.assertEqual(n_orders, 1)
        n_reviews = self.conn.execute(
            "SELECT COUNT(*) c FROM review_queue WHERE kind='payment_no_ticket' "
            "AND ref_id='ord_off_1'").fetchone()["c"]
        self.assertEqual(n_reviews, 1)

        # 再同步一次必须无副作用
        again = self.svc.sync_spool(self.conn, "TVM_O")
        self.assertEqual(again["applied"], 0)
        n_orders2 = self.conn.execute(
            "SELECT COUNT(*) c FROM payment_orders WHERE order_no='ord_off_1'"
        ).fetchone()["c"]
        self.assertEqual(n_orders2, 1)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) c FROM device_receipts WHERE synced=0")
            .fetchone()["c"], 0)

    def test_receipt_files_written_locally(self):
        self._bootstrap(terminal="TVM_F", count=10, start=50_001)
        self.buy("rcpt-1", terminal="TVM_F")
        row = self.conn.execute(
            "SELECT file_path FROM device_receipts WHERE terminal_id='TVM_F' "
            "AND kind='ticket_issued'").fetchone()
        self.assertTrue(os.path.isfile(row["file_path"]))
        with open(row["file_path"], encoding="utf-8") as f:
            body = json.load(f)
        self.assertEqual(body["payload"]["order_no"][:4], "ord_")


# ---------------------------------------------------------------------------
# 5) 退款权限与补给/补票规则
# ---------------------------------------------------------------------------
class RefundPermissionTest(CaseBase):

    def _ticketed_order(self, key="rf-base"):
        order, _ = self.buy(key)
        return order["order_no"]

    def test_one_refund_per_order(self):
        on = self._ticketed_order()
        self.svc.apply_refund(self.conn, on, "乘客", "取消行程")
        with self.assertRaises(ValueError):
            self.svc.apply_refund(self.conn, on, "乘客", "再退一次")

    def test_only_finance_approves(self):
        on = self._ticketed_order()
        rid = self.svc.apply_refund(self.conn, on, "乘客", "取消")
        with self.assertRaises(PermissionError):
            self.svc.decide_refund(self.conn, rid, "approve", "replenisher")
        with self.assertRaises(PermissionError):
            self.svc.decide_refund(self.conn, rid, "approve", "supervisor")
        with self.assertRaises(PermissionError):
            self.svc.decide_refund(self.conn, rid, "approve", "viewer")
        # 财务批准后订单变为已退款,不可二次审批
        self.svc.decide_refund(self.conn, rid, "approve", "finance")
        with self.assertRaises(ValueError):
            self.svc.decide_refund(self.conn, rid, "approve", "finance")
        self.assertEqual(self.svc._order(self.conn, on)["status"], "refunded")

    def test_supervisor_can_reject_and_order_restored(self):
        on = self._ticketed_order("rf-rej")
        rid = self.svc.apply_refund(self.conn, on, "乘客", "误申请")
        self.svc.decide_refund(self.conn, rid, "reject", "supervisor", "驳回")
        self.assertEqual(self.svc._order(self.conn, on)["status"], "ticketed")

    def test_refund_timeout_enters_review(self):
        on = self._ticketed_order("rf-to")
        rid = self.svc.apply_refund(self.conn, on, "乘客", "超时用")
        self.conn.execute(
            "UPDATE refunds SET created_at=datetime('now','-10 minutes') WHERE id=?",
            (rid,))
        n = self.svc.timeout_refunds(self.conn, older_than_seconds=300)
        self.assertEqual(n, 1)
        self.assertEqual(
            self.conn.execute("SELECT status FROM refunds WHERE id=?", (rid,))
            .fetchone()[0], "timeout")
        self.assertGreaterEqual(
            self.conn.execute(
                "SELECT COUNT(*) c FROM review_queue WHERE kind='refund_timeout'")
            .fetchone()["c"], 1)

    def test_manual_issue_requires_work_order_and_supervisor(self):
        # 卡纸 → 已扣款未出票,自动生成关联工单
        self.adapters.set_jam(self.terminal, True)
        order, info = self.buy("manual-1")
        self.assertEqual(info.get("blocked"), "jam")
        wid = self.conn.execute(
            "SELECT id FROM fault_work_orders WHERE related_order=?",
            (order["order_no"],)).fetchone()[0]

        with self.assertRaises(PermissionError):
            self.svc.manual_issue(self.conn, wid, "replenisher")
        # 现场清除卡纸(人工补票本身即工单结案动作,无需先结案)
        self.adapters.reset_faults(self.terminal)
        ticket = self.svc.manual_issue(self.conn, wid, "supervisor")
        self.assertTrue(ticket.startswith("T"))
        # 补票必须回挂工单
        linked = self.conn.execute(
            "SELECT work_order, flag FROM ticket_issues WHERE ticket_no=?",
            (ticket,)).fetchone()
        self.assertEqual(linked["work_order"], wid)
        self.assertEqual(linked["flag"], "manual")
        # 同一工单不能再补
        with self.assertRaises(ValueError):
            self.svc.manual_issue(self.conn, wid, "supervisor")


class ReplenishLockTest(CaseBase):

    def test_double_claim_single_locker(self):
        task = self.svc.create_replenish_task(self.conn, self.terminal)
        sc = self.conn.execute("SELECT scan_code FROM replenish_tasks WHERE id=?",
                               (task,)).fetchone()[0]
        winners = []

        def claim(uid):
            conn = self.database.connect()
            try:
                r = self.svc.claim_task(conn, task, uid, sc)
                if r["won"]:
                    winners.append(uid)
            finally:
                conn.close()

        t1 = threading.Thread(target=claim, args=("u_lin",))
        t2 = threading.Thread(target=claim, args=("u_zhao",))
        t1.start(); t2.start(); t1.join(); t2.join()
        self.assertEqual(len(winners), 1, "只允许一个锁定者")

        locked = self.conn.execute(
            "SELECT locked_by,status FROM replenish_tasks WHERE id=?",
            (task,)).fetchone()
        self.assertEqual(locked["status"], "locked")
        self.assertIn(locked["locked_by"], ("u_lin", "u_zhao"))

    def test_scan_required_to_open_cabinet(self):
        task = self.svc.create_replenish_task(self.conn, self.terminal)
        with self.assertRaises(ValueError):
            self.svc.claim_task(self.conn, task, "u_lin", "")
        with self.assertRaises(ValueError):
            self.svc.claim_task(self.conn, task, "u_lin", "fake-scan-code")

    def test_reversed_roll_blocked_at_install(self):
        bad = self.svc.receive_batch(
            self.conn, "劣质供应商", 200, 60_001, 60_200, reversed_=True)
        with self.assertRaises(ValueError):
            self.svc.install_batch(self.conn, self.terminal, bad)

        task = self.svc.create_replenish_task(self.conn, self.terminal)
        sc = self.conn.execute("SELECT scan_code FROM replenish_tasks WHERE id=?",
                               (task,)).fetchone()[0]
        self.svc.claim_task(self.conn, task, "u_lin", sc)
        with self.assertRaises(ValueError):
            self.svc.complete_task(self.conn, task, "u_lin", bad, 10, 210)
        self.assertGreaterEqual(
            self.conn.execute(
                "SELECT COUNT(*) c FROM review_queue WHERE kind='roll_reversed'")
            .fetchone()["c"], 1)

    def test_counter_photos_required_and_saved(self):
        nb = self.svc.receive_batch(
            self.conn, "测试纸厂", 200, 70_001, 70_200)
        task = self.svc.create_replenish_task(self.conn, self.terminal)
        sc = self.conn.execute("SELECT scan_code FROM replenish_tasks WHERE id=?",
                               (task,)).fetchone()[0]
        self.svc.claim_task(self.conn, task, "u_zhao", sc)
        res = self.svc.complete_task(self.conn, task, "u_zhao", nb, 50, 250)
        self.assertTrue(os.path.isfile(res["photo_before"]))
        self.assertTrue(os.path.isfile(res["photo_after"]))
        # 非锁定者不能完成任务
        task2 = self.svc.create_replenish_task(self.conn, self.terminal)
        sc2 = self.conn.execute("SELECT scan_code FROM replenish_tasks WHERE id=?",
                                (task2,)).fetchone()[0]
        self.svc.claim_task(self.conn, task2, "u_lin", sc2)
        with self.assertRaises(PermissionError):
            self.svc.complete_task(self.conn, task2, "u_zhao",
                                   self.svc.receive_batch(
                                       self.conn, "x", 10, 80_001, 80_010),
                                   1, 11)


if __name__ == "__main__":
    unittest.main(verbosity=2)
