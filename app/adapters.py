"""进程内模拟适配器:支付网关与票据打印机。

真实系统中它们是外部硬件/服务,这里全部由内存状态模拟,
失败模式通过开关触发,用于演示和测试。
"""
import hashlib
import json
import os
import threading
import uuid
from datetime import datetime

from . import config

# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def receipt_path(terminal_id, event_id):
    d = os.path.join(config.RECEIPT_DIR, terminal_id)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{event_id}.json")


def write_device_receipt(terminal_id, event_id, kind, payload):
    """设备回执写入本地文件(JSON),并返回文件路径。"""
    path = receipt_path(terminal_id, event_id)
    body = {
        "event_id": event_id,
        "terminal_id": terminal_id,
        "kind": kind,
        "emitted_at": now(),
        "payload": payload,
        "sha256": "",
    }
    body["sha256"] = hashlib.sha256(
        json.dumps(body["payload"], ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return path


# ---------------------------------------------------------------------------
# 支付适配器
# ---------------------------------------------------------------------------

class PaymentAdapter:
    """模拟支付网关。pay 幂等:相同 idem_key 只扣款一次。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._charges = {}          # idem_key -> charge dict
        self.fail_next = False      # 下一笔支付模拟失败
        self.timeout_next = False   # 下一笔模拟网关超时(扣款状态未知)

    def pay(self, idem_key, amount_fen, order_no):
        with self._lock:
            if idem_key in self._charges:
                ch = self._charges[idem_key]
                return {"ok": True, "replayed": True, "charge_id": ch["charge_id"],
                        "amount_fen": ch["amount_fen"]}
            if self.fail_next:
                self.fail_next = False
                return {"ok": False, "replayed": False, "error": "支付被拒绝(模拟)"}
            if self.timeout_next:
                self.timeout_next = False
                # 超时场景:网关实际可能已扣款,平台侧标记为待核验
                return {"ok": False, "replayed": False, "error": "支付网关超时(模拟)",
                        "uncertain": True}
            charge_id = new_id("ch")
            self._charges[idem_key] = {
                "charge_id": charge_id,
                "order_no": order_no,
                "amount_fen": amount_fen,
                "paid_at": now(),
            }
            return {"ok": True, "replayed": False, "charge_id": charge_id,
                    "amount_fen": amount_fen}

    def refund(self, order_no, amount_fen):
        """模拟退款出款。"""
        return {"ok": True, "refund_id": new_id("rf"), "amount_fen": amount_fen,
                "refunded_at": now()}

    def charges(self):
        with self._lock:
            return list(self._charges.values())


# ---------------------------------------------------------------------------
# 打印机适配器
# ---------------------------------------------------------------------------

# 打印机故障开关(进程级,演示用)
_printer_lock = threading.Lock()
_printer_state = {
    # terminal_id -> {"jam": bool, "out": bool, "force_dup": bool}
}


def _state(terminal_id):
    return _printer_state.setdefault(terminal_id, {"jam": False, "out": False, "force_dup": False})


def set_jam(terminal_id, on=True):
    with _printer_lock:
        _state(terminal_id)["jam"] = on


def set_out_trigger(terminal_id, on=True):
    with _printer_lock:
        _state(terminal_id)["out"] = on


def set_force_duplicate(terminal_id, on=True):
    """演示:打印机在出票后又重打一张同号票(重复出票)。"""
    with _printer_lock:
        _state(terminal_id)["force_dup"] = on


def reset_faults(terminal_id=None):
    with _printer_lock:
        if terminal_id:
            _printer_state.pop(terminal_id, None)
        else:
            _printer_state.clear()


class PrinterError(Exception):
    def __init__(self, reason, terminal_id=None):
        super().__init__(reason)
        self.reason = reason
        self.terminal_id = terminal_id


class PrinterAdapter:
    """模拟终端打印机。

    关键规则:号段由平台分配,打印机只能按号连续打印;
    断纸/卡纸/号段用尽时拒打,绝不跳号继续。
    """

    def print_ticket(self, terminal_id, ticket_no, order_no, reversed_paper=False):
        st = _state(terminal_id)
        with _printer_lock:
            if st["out"]:
                st["out"] = False
                raise PrinterError("paper_out", terminal_id)
            if st["jam"]:
                raise PrinterError("jam", terminal_id)
        # 倒装纸卷:票面空白/反向,打印机自检能识别
        if reversed_paper:
            raise PrinterError("roll_reversed", terminal_id)
        return {"printed": True, "ticket_no": ticket_no, "order_no": order_no,
                "printed_at": now()}


# 单例:整个进程共享同一组模拟外部服务
payment = PaymentAdapter()
printer = PrinterAdapter()
