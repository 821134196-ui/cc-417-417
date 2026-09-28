"""标准库 HTTP 服务:JSON API + 静态前端 + 本地回执/照片文件。

启动: python -m app.server [--port 8000]
"""
import argparse
import json
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import adapters, config
from .database import connect, init_db
from . import services as svc

WEB_DIR = os.path.join(config.BASE_DIR, "web")

# 多线程共享同一连接文件;SQLite WAL + busy_timeout 下并发安全
_db_lock = threading.Lock()


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def db():
    return connect()


class Handler(BaseHTTPRequestHandler):
    server_version = "TicketVM/1.0"

    # ---------------- 基础响应 ----------------
    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self, rel):
        rel = rel.lstrip("/")
        path = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not path.startswith(WEB_DIR) or not os.path.isfile(path):
            path = os.path.join(WEB_DIR, "index.html")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8"
                         if ctype.startswith("text/") or "javascript" in ctype or "svg" in ctype
                         else ""))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ApiError("请求体不是合法 JSON")

    def log_message(self, fmt, *args):
        pass

    # ---------------- 路由 ----------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                self._route_get(path, qs)
            elif path.startswith("/files/"):
                self._serve_data_file(path[len("/files/"):])
            else:
                self._static(path[1:] if path != "/" else "index.html")
        except ApiError as e:
            self._json({"error": str(e)}, e.status)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            self._json({"error": "not found"}, 404)
            return
        try:
            body = self._read_body()
            self._route_post(path, body)
        except PermissionError as e:
            self._json({"error": f"权限不足: {e}"}, 403)
        except ApiError as e:
            self._json({"error": str(e)}, e.status)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def _serve_data_file(self, rel):
        base = os.path.abspath(config.DATA_DIR)
        path = os.path.abspath(os.path.join(base, rel))
        if not path.startswith(base) or not os.path.isfile(path):
            self._json({"error": "文件不存在"}, 404)
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------------- GET API ----------------
    def _route_get(self, path, qs):
        conn = db()
        try:
            if path == "/api/overview":
                terms = svc.list_terminals(conn)
                orders = svc.list_orders(conn, 500)
                refunds = svc.list_refunds(conn)
                reviews = svc.list_review_queue(conn)
                tasks = svc.list_tasks(conn)
                self._json({
                    "terminals": terms,
                    "orders": orders,
                    "refunds": refunds,
                    "review_queue": reviews,
                    "tasks": tasks,
                    "stats": {
                        "terminals": len(terms),
                        "online": sum(1 for t in terms if t["online"]),
                        "faults": sum(1 for t in terms if t["status"] != "normal"),
                        "paper_total": sum(t["paper_remaining"] for t in terms),
                        "paid_no_ticket": sum(1 for o in orders
                                              if o["status"] == "paid"),
                        "pending_review": sum(1 for r in reviews
                                              if r["status"] == "pending"),
                        "refund_pending": sum(1 for r in refunds
                                              if r["status"] == "pending"),
                        "gmv_fen": sum(o["amount_fen"] for o in orders
                                       if o["status"] in ("ticketed", "refunding",
                                                          "refunded")),
                    },
                })
            elif path == "/api/terminals":
                self._json(svc.list_terminals(conn))
            elif path == "/api/batches":
                self._json(svc.list_batches(conn))
            elif path == "/api/orders":
                self._json(svc.list_orders(conn))
            elif path == "/api/work-orders":
                self._json(svc.list_work_orders(conn))
            elif path == "/api/review-queue":
                self._json(svc.list_review_queue(conn))
            elif path == "/api/tasks":
                self._json(svc.list_tasks(conn))
            elif path == "/api/routes":
                self._json(svc.list_routes(conn))
            elif path == "/api/refunds":
                self._json(svc.list_refunds(conn))
            elif path == "/api/evidence":
                order_no = (qs.get("order_no") or [""])[0]
                self._json(svc.evidence_chain(conn, order_no))
            elif path == "/api/receipts":
                rows = conn.execute(
                    "SELECT * FROM device_receipts ORDER BY id DESC LIMIT 100").fetchall()
                out = []
                for r in rows:
                    d = dict(r)
                    d["file_url"] = "/files/" + os.path.relpath(
                        d["file_path"], config.DATA_DIR)
                    out.append(d)
                self._json(out)
            else:
                self._json({"error": "未知接口"}, 404)
        finally:
            conn.close()

    # ---------------- POST API ----------------
    def _route_post(self, path, body):
        conn = db()
        try:
            with _db_lock:
                if path == "/api/buy":
                    order, info = svc.buy_ticket(
                        conn, body["terminal_id"], int(body["amount_fen"]),
                        idem_key=body.get("idem_key"))
                    self._json({"order": order, "result": info})

                elif path == "/api/tasks/create":
                    tid = svc.create_replenish_task(conn, body["terminal_id"],
                                                    body.get("note", ""))
                    self._json({"task_id": tid})

                elif path == "/api/tasks/claim":
                    res = svc.claim_task(conn, body["task_id"], body["user_id"],
                                         body.get("scan_code", ""))
                    self._json(res)

                elif path == "/api/tasks/complete":
                    res = svc.complete_task(
                        conn, body["task_id"], body["user_id"], body["batch_id"],
                        int(body["counter_before"]), int(body["counter_after"]))
                    self._json(res)

                elif path == "/api/batches/receive":
                    bid = svc.receive_batch(
                        conn, body["supplier"], int(body["ticket_count"]),
                        int(body["segment_start"]), int(body["segment_end"]),
                        reversed_=bool(body.get("reversed", False)))
                    self._json({"batch_id": bid})

                elif path == "/api/terminals/offline":
                    wid = svc.mark_offline(conn, body["terminal_id"])
                    self._json({"work_order": wid})

                elif path == "/api/terminals/online":
                    svc.mark_online(conn, body["terminal_id"])
                    self._json({"ok": True})

                elif path == "/api/spool":
                    eid, dup = svc.spool_event(
                        conn, body["terminal_id"], body["kind"], body.get("payload", {}),
                        event_id=body.get("event_id"))
                    self._json({"event_id": eid, "duplicate": dup})

                elif path == "/api/sync":
                    self._json(svc.sync_spool(conn, body["terminal_id"]))

                elif path == "/api/refunds/apply":
                    rid = svc.apply_refund(conn, body["order_no"],
                                           body.get("applicant", "乘客"),
                                           body.get("reason", ""))
                    self._json({"refund_id": rid})

                elif path == "/api/refunds/decide":
                    svc.decide_refund(conn, body["refund_id"], body["action"],
                                      body["role"], body.get("note", ""))
                    self._json({"ok": True})

                elif path == "/api/work-orders/manual-issue":
                    no = svc.manual_issue(conn, body["work_order_id"], body["role"])
                    self._json({"ticket_no": no})

                elif path == "/api/work-orders/resolve":
                    svc.resolve_work_order(conn, body["work_order_id"],
                                           body.get("resolution", "已处理"), body["role"])
                    self._json({"ok": True})

                elif path == "/api/review/resolve":
                    svc.resolve_review(conn, int(body["review_id"]),
                                       body.get("resolution", "已核销"), body["role"])
                    self._json({"ok": True})

                elif path == "/api/printer/jam":
                    adapters.set_jam(body["terminal_id"], True)
                    self._json({"ok": True})

                elif path == "/api/printer/dup":
                    adapters.set_force_duplicate(body["terminal_id"], True)
                    self._json({"ok": True})

                elif path == "/api/printer/reset":
                    adapters.reset_faults(body.get("terminal_id"))
                    self._json({"ok": True})

                elif path == "/api/routes/create":
                    rid = svc.create_route(conn, body["name"], body["task_ids"])
                    self._json({"route_id": rid})

                else:
                    self._json({"error": "未知接口"}, 404)
        finally:
            conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("TVM_PORT", 8000)))
    ap.add_argument("--init", action="store_true", help="仅初始化数据库")
    args = ap.parse_args()
    os.makedirs(config.RECEIPT_DIR, exist_ok=True)
    os.makedirs(config.PHOTO_DIR, exist_ok=True)
    init_db()
    if args.init:
        return
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"票务自助机平台运行中: http://localhost:{args.port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
