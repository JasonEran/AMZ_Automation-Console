#!/bin/sh
set -eu
umask 077

env_dir=/etc/amzguard

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行 deploy/bootstrap-linux-env.sh" >&2
  exit 2
fi

for required_command in install mktemp openssl mv chmod chown; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "缺少必需命令: $required_command" >&2
    exit 2
  }
done

install -d -m 0700 -o root -g root "$env_dir"

for protected_name in dashboard ziniao channels retention product-upload; do
  if [ -e "$env_dir/$protected_name.env" ] || [ -L "$env_dir/$protected_name.env" ]; then
    echo "EnvironmentFile 已存在，拒绝覆盖: $protected_name.env" >&2
    exit 2
  fi
done

write_protected_file() {
  destination=$1
  content=$2
  temporary=$(mktemp "$env_dir/.bootstrap.XXXXXX")
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  printf '%s\n' "$content" > "$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv "$temporary" "$destination"
  trap - EXIT HUP INT TERM
}

dashboard_password=$(openssl rand -hex 20)
session_secret=$(openssl rand -hex 32)
ingest_token=$(openssl rand -hex 32)

write_protected_file "$env_dir/dashboard.env" "NODE_ENV=production
HOST=127.0.0.1
PORT=4173
TRUST_PROXY=1
DASHBOARD_USERNAME=admin
$(printf '%s=%s\n' \
  DASHBOARD_PASSWORD "$dashboard_password" \
  DASHBOARD_SESSION_SECRET "$session_secret" \
  AMZGUARD_INGEST_TOKEN "$ingest_token")
REPORT_STALE_HOURS=36
COLLECTOR_HEALTH_REQUIRED=1
AMZGUARD_ZINIAO_CONFIGURED=1
AMZGUARD_DINGTALK_CONFIGURED=1
AMZGUARD_CRM_CONFIGURED=0"

write_protected_file "$env_dir/ziniao.env" "ZINIAO_CLIENT_PATH=/opt/ziniao/ziniaobrowser
ZINIAO_SOCKET_PORT=18888"

write_protected_file "$env_dir/channels.env" "DASHBOARD_PUBLIC_URL=https://amzcheck.pc51.com
DINGTALK_WEBHOOK=
DINGTALK_SECRET=
DINGTALK_OPS_WEBHOOK=
DINGTALK_OPS_SECRET=
DINGTALK_BUSINESS_WEBHOOK=
DINGTALK_BUSINESS_SECRET=
CRM_ENDPOINT=
CRM_TOKEN="

write_protected_file "$env_dir/retention.env" "AMZGUARD_EVIDENCE_RETENTION_DAYS=45
AMZGUARD_REPORT_RETENTION_DAYS=365
AMZGUARD_LOG_RETENTION_DAYS=60
AMZGUARD_AUDIT_RETENTION_DAYS=365
AMZGUARD_UPLOAD_PAYLOAD_RETENTION_DAYS=7"

write_protected_file "$env_dir/product-upload.env" "AMZGUARD_PRODUCT_UPLOAD_ENABLED=0
AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED=0
AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME=admin
AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH=/usr/bin/clamscan
AMZGUARD_PRODUCT_UPLOAD_SIGNATURE_MAX_AGE_DAYS=7"

echo "已创建拆分的 root-only EnvironmentFile；未输出任何凭据。"
