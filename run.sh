#!/usr/bin/env bash
# 票务自助机纸卷补给与退款核验平台 —— 单条本地启动命令
#
# 用法:
#   ./run.sh            首次自动生成演示数据并启动 Web(之后复用现有数据)
#   ./run.sh --reset    清空 data/、重建演示数据(出票/卡纸/退款/离线/倒装)并启动
#   ./run.sh seed       仅重建演示数据
#   ./run.sh test       运行测试(号段连续/幂等/并发扣减/离线补传/退款权限)
#   PORT=8123 ./run.sh  指定端口
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
PORT="${PORT:-8000}"
export TVM_DATA_DIR="${TVM_DATA_DIR:-$PWD/data}"

cmd="${1:-serve}"

if [[ "$cmd" == "test" ]]; then
  "$PY" -m unittest discover -s tests -v
  exit 0
fi

if [[ "$cmd" == "seed" || "$cmd" == "--reset" ]]; then
  echo ">> 生成演示数据(正常出票 / 卡纸 / 重复出票 / 退款超时 / 倒装卷 / 离线补传)…"
  "$PY" -m app.demo --reset
fi

if [[ "$cmd" == "seed" ]]; then
  exit 0
fi

if [[ ! -f "$TVM_DATA_DIR/tvm.db" ]]; then
  echo ">> 首次启动,生成演示数据…"
  "$PY" -m app.demo --reset
fi

echo ">> 启动平台 http://localhost:$PORT (Ctrl+C 退出)"
exec "$PY" -m app.server --port "$PORT"
