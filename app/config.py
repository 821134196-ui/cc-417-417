"""全局路径与运行参数。所有状态都保存在工作目录下，便于测试隔离。"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("TVM_DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.environ.get("TVM_DB", os.path.join(DATA_DIR, "tvm.db"))
RECEIPT_DIR = os.path.join(DATA_DIR, "receipts")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
SPOOL_DIR = os.path.join(DATA_DIR, "spool")

INDIGO = "#3949ab"
LIGHT_GRAY = "#f3f4f8"
BRIGHT_YELLOW = "#ffd400"
