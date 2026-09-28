"""一键生成演示数据:正常出票、卡纸(扣款未出票)、重复出票、
退款超时、纸卷倒装、设备离线补传、补给路线与待审批退款。

用法: python -m app.demo [--reset]
"""
import argparse
import os
import shutil

from . import adapters, config
from .database import connect, init_db
from . import services as svc

PRICE = 500  # 5.00 元


def reset_data():
    if os.path.isdir(config.DATA_DIR):
        shutil.rmtree(config.DATA_DIR)
    for d in (config.RECEIPT_DIR, config.PHOTO_DIR, config.SPOOL_DIR):
        os.makedirs(d, exist_ok=True)


def seed():
    conn = connect()
    init_db(conn)

    # ---- 纸卷入库:每卷 200 张,自带号段 ----
    b1 = svc.receive_batch(conn, "晨光纸业", 200, 1_000_001, 1_000_200)
    b2 = svc.receive_batch(conn, "晨光纸业", 200, 1_000_201, 1_000_400)
    b3 = svc.receive_batch(conn, "晨光纸业", 200, 1_000_401, 1_000_600)
    b4 = svc.receive_batch(conn, "晨光纸业", 200, 1_000_601, 1_000_800)
    b5 = svc.receive_batch(conn, "晨光纸业", 200, 1_000_801, 1_001_000)
    b_rev = svc.receive_batch(conn, "顺达耗材", 200, 1_001_001, 1_001_200,
                              reversed_=True)  # 倒装卷
    # 库房备用卷(补给路线实际要换上的新卷)
    b_spare1 = svc.receive_batch(conn, "晨光纸业", 200, 1_001_401, 1_001_600)
    b_spare2 = svc.receive_batch(conn, "晨光纸业", 200, 1_001_601, 1_001_800)

    # ---- 6 台终端(坐标为地图百分比) ----
    terminals = [
        ("TVM01", "中央广场站", "1F 大厅中央", 22, 30),
        ("TVM02", "地铁东站",   "B1 东通道",   74, 24),
        ("TVM03", "西站",       "1F 西入口",   14, 70),
        ("TVM04", "南站",       "2F 南连廊",   60, 72),
        ("TVM05", "北站",       "B1 北广场",   84, 60),
        ("TVM06", "机场航站楼", "T2 出发层",   44, 48),
    ]
    for tid, name, loc, x, y in terminals:
        svc.create_terminal(conn, tid, name, loc, x, y)

    # 装卷
    svc.install_batch(conn, "TVM01", b1)
    svc.install_batch(conn, "TVM02", b2)
    svc.install_batch(conn, "TVM03", b3)
    svc.install_batch(conn, "TVM04", b4)
    svc.install_batch(conn, "TVM06", b5)
    # TVM05(北站)先不装,稍后模拟离线;用另一卷模拟其已在运行
    b_extra = svc.receive_batch(conn, "晨光纸业", 200, 1_001_201, 1_001_400)
    svc.install_batch(conn, "TVM05", b_extra)

    # ---- TVM01 正常售出 36 张 ----
    for _ in range(36):
        svc.buy_ticket(conn, "TVM01", PRICE)

    # ---- TVM02 号段即将用尽:只留 3 张,然后售空触发停车 ----
    conn.execute("UPDATE terminals SET paper_remaining=3, seg_next=? WHERE id='TVM02'",
                 (1_000_400 - 2,))
    for _ in range(4):  # 第 4 笔扣款后无纸可打
        svc.buy_ticket(conn, "TVM02", PRICE)
    task02 = svc.create_replenish_task(conn, "TVM02", "号段用尽,请整卷更换")

    # ---- TVM03 卡纸:扣款成功未出票,票号不跳号 ----
    adapters.set_jam("TVM03", True)
    svc.buy_ticket(conn, "TVM03", PRICE)
    # 故障未排除前再来的乘客也被拦下(出票前闸门)
    svc.buy_ticket(conn, "TVM03", PRICE)
    task03 = svc.create_replenish_task(conn, "TVM03", "卡纸维修并检查余纸")

    # ---- TVM04 重复出票 ----
    adapters.set_force_duplicate("TVM04", True)
    svc.buy_ticket(conn, "TVM04", PRICE)

    # ---- TVM05 设备离线 + 离线事件补传(暂存,恢复后补传) ----
    svc.mark_offline(conn, "TVM05")
    svc.spool_event(conn, "TVM05", "sale_attempt",
                    {"order_no": "ord_offline_demo_01", "amount_fen": PRICE,
                     "note": "离线期间扫码扣款"})
    svc.spool_event(conn, "TVM05", "jam_reported", {"sensor": "exit_slot"})
    # 演示:保持离线,等用户在界面点"恢复在线并补传"

    # ---- TVM06 纸卷倒装:补给员领到倒装卷,装机被拒 ----
    task06 = svc.create_replenish_task(conn, "TVM06", "常规换卷巡检")
    claim06 = svc.claim_task(conn, task06, "u_lin",
                             conn.execute("SELECT scan_code FROM replenish_tasks WHERE id=?",
                                          (task06,)).fetchone()["scan_code"])
    assert claim06["won"]
    try:
        svc.complete_task(conn, task06, "u_lin", b_rev, 12, 212)
    except ValueError as e:
        print(f"  [演示] 倒装卷被拦截: {e}")

    # ---- 退款台账:一笔待财务审批,一笔审批超时 ----
    paid_orders = conn.execute(
        "SELECT order_no FROM payment_orders WHERE terminal_id='TVM01' "
        "AND status='ticketed' ORDER BY id LIMIT 2").fetchall()
    r_pending = svc.apply_refund(conn, paid_orders[0]["order_no"], "乘客陈女士",
                                 "行程取消,申请原路退回")
    r_timeout = svc.apply_refund(conn, paid_orders[1]["order_no"], "乘客李先生",
                                 "重复购票,客服已登记")
    # 把第二笔申请时间回拨到 10 分钟前,模拟审批超时(第一笔保持待审批)
    conn.execute(
        "UPDATE refunds SET created_at=datetime('now','-10 minutes') WHERE id=?",
        (r_timeout,))
    svc.timeout_refunds(conn, older_than_seconds=300)

    # ---- 补给路线 ----
    route = svc.create_route(conn, "周三上午 B 线(东-西向)",
                             [task02, task03, task06])

    conn.close()
    print("演示数据已生成:")
    print("  TVM01 正常;TVM02 号段用尽(缺纸停车)")
    print("  TVM03 卡纸(扣款未出票);TVM04 重复出票")
    print("  TVM05 离线,2 条事件待补传;TVM06 倒装卷被拦截")
    print(f"  待审批退款 {r_pending};超时退款单已入复核队列")
    print(f"  补给路线 {route}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="清空 data/ 后重建")
    args = ap.parse_args()
    if args.reset or not os.path.exists(config.DB_PATH):
        reset_data()
    seed()


if __name__ == "__main__":
    main()
