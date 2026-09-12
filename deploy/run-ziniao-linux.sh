#!/bin/sh
set -eu

client="${ZINIAO_CLIENT_PATH:-/opt/ziniao/ziniaobrowser}"
port="${ZINIAO_SOCKET_PORT:-18888}"

"$client" \
  --no-sandbox \
  --disable-gpu \
  --run_type=web_driver \
  --ipc_type=http \
  "--port=$port" &
launcher_pid=$!

stop() {
  kill "$launcher_pid" 2>/dev/null || true
  exit 0
}
trap stop INT TERM

# Electron's launcher may exit after it has forked the long-lived processes.
# Keep this wrapper as systemd's main process and use the documented local HTTP
# endpoint as the real liveness signal.
ready=0
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS --connect-timeout 2 --max-time 120 \
    -H 'Content-Type: application/json' \
    -d '{"action":"getRunningInfo","requestId":"systemd-health"}' \
    "http://127.0.0.1:$port" >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  wait "$launcher_pid" 2>/dev/null || true
  exit 1
fi

failures=0
while :; do
  if curl -fsS --connect-timeout 3 --max-time 120 \
    -H 'Content-Type: application/json' \
    -d '{"action":"getRunningInfo","requestId":"systemd-health"}' \
    "http://127.0.0.1:$port" >/dev/null 2>&1; then
    failures=0
  else
    failures=$((failures + 1))
    [ "$failures" -lt 6 ] || exit 1
  fi
  sleep 10
done
