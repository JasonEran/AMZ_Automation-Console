#!/usr/bin/env bash
set -euo pipefail
umask 077

destination=/etc/amzguard/channels.env
public_url=https://amzcheck.pc51.com

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 sudo 运行 deploy/configure-channels-linux.sh" >&2
  exit 2
fi
if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
  echo "需要在交互式 SSH 终端中运行，拒绝从参数或管道读取凭据。" >&2
  exit 2
fi

read_hidden() {
  local variable_name=$1
  local prompt=$2
  local value
  IFS= read -r -s -p "$prompt" value </dev/tty
  printf '\n' >/dev/tty
  printf -v "$variable_name" '%s' "$value"
}

read_hidden regular_webhook '常规/业务机器人 Webhook（输入隐藏）: '
read_hidden regular_secret '常规/业务机器人 Secret（输入隐藏）: '
read_hidden operations_webhook '技术运维机器人 Webhook（输入隐藏）: '
read_hidden operations_secret '技术运维机器人 Secret（输入隐藏）: '

for webhook in "$regular_webhook" "$operations_webhook"; do
  case "$webhook" in
    https://oapi.dingtalk.com/robot/send\?access_token=*) ;;
    *) echo "Webhook 格式不符合钉钉机器人地址，未写入。" >&2; exit 2 ;;
  esac
done
for secret in "$regular_secret" "$operations_secret"; do
  case "$secret" in
    SEC????????????????????????????????????????????????????????????????) ;;
    *) echo "Secret 格式不符合 SEC 加 64 位字符，未写入。" >&2; exit 2 ;;
  esac
done

install -d -m 0700 -o root -g root /etc/amzguard
temporary=$(mktemp /etc/amzguard/.channels.env.XXXXXX)
trap 'rm -f "$temporary"' EXIT HUP INT TERM
printf '%s\n' \
  "DASHBOARD_PUBLIC_URL=$public_url" \
  "DINGTALK_WEBHOOK=$regular_webhook" \
  "DINGTALK_SECRET=$regular_secret" \
  "DINGTALK_OPS_WEBHOOK=$operations_webhook" \
  "DINGTALK_OPS_SECRET=$operations_secret" \
  'CRM_ENDPOINT=' \
  'CRM_TOKEN=' > "$temporary"
chmod 0600 "$temporary"
chown root:root "$temporary"
mv -f "$temporary" "$destination"
trap - EXIT HUP INT TERM

echo "双钉钉通道已写入 root-only EnvironmentFile；未输出任何凭据。"
