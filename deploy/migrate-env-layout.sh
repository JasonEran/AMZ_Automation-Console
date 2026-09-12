#!/bin/sh
set -eu
export LC_ALL=C
umask 077

env_dir=/etc/amzguard
legacy_env="$env_dir/amzguard.env"
dashboard_env="$env_dir/dashboard.env"
ziniao_env="$env_dir/ziniao.env"
collector_env="$env_dir/collector.env"
channels_env="$env_dir/channels.env"
retention_env="$env_dir/retention.env"
product_upload_env="$env_dir/product-upload.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行 deploy/migrate-env-layout.sh" >&2
  exit 2
fi

for command_name in awk install mktemp stat; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "缺少必需命令: $command_name" >&2
    exit 2
  }
done

test ! -L "$env_dir" || {
  echo "EnvironmentFile 目录不得是符号链接" >&2
  exit 2
}
install -d -m 0700 -o root -g root "$env_dir"
test -f "$legacy_env" || {
  echo "未找到旧 EnvironmentFile: $legacy_env" >&2
  exit 2
}
test ! -L "$legacy_env" || {
  echo "旧 EnvironmentFile 不得是符号链接" >&2
  exit 2
}

for destination in "$dashboard_env" "$ziniao_env" "$collector_env" "$channels_env" "$retention_env" "$product_upload_env"; do
  if test -e "$destination" || test -L "$destination"; then
    echo "目标已存在，拒绝覆盖: $destination" >&2
    exit 2
  fi
done

# Never evaluate the legacy file: EnvironmentFile content is data, not shell.
# Reject unexpected syntax, then copy only an explicit allow-list of keys.
awk '
  /^[[:space:]]*$/ { next }
  /^[[:space:]]*#/ { next }
  /^[A-Z_][A-Z0-9_]*=/ { next }
  { exit 1 }
' "$legacy_env" || {
  echo "旧 EnvironmentFile 含无法安全迁移的语法；请使用 sudoedit 手工迁移" >&2
  exit 2
}

chown root:root "$legacy_env"
chmod 0600 "$legacy_env"

dashboard_tmp=$(mktemp "$env_dir/.dashboard.env.XXXXXX")
ziniao_tmp=$(mktemp "$env_dir/.ziniao.env.XXXXXX")
collector_tmp=$(mktemp "$env_dir/.collector.env.XXXXXX")
channels_tmp=$(mktemp "$env_dir/.channels.env.XXXXXX")
retention_tmp=$(mktemp "$env_dir/.retention.env.XXXXXX")
product_upload_tmp=$(mktemp "$env_dir/.product-upload.env.XXXXXX")
migration_committed=0
cleanup() {
  rm -f "$dashboard_tmp" "$ziniao_tmp" "$collector_tmp" "$channels_tmp" "$retention_tmp" "$product_upload_tmp"
  if [ "$migration_committed" -eq 0 ]; then
    rm -f "$dashboard_env" "$ziniao_env" "$collector_env" "$channels_env" "$retention_env" "$product_upload_env"
  fi
}
trap cleanup EXIT HUP INT TERM

printf '%s\n' '# Generated from legacy amzguard.env without evaluating or displaying values.' > "$dashboard_tmp"
printf '%s\n' '# Generated from legacy amzguard.env without evaluating or displaying values.' > "$ziniao_tmp"
printf '%s\n' '# Generated from legacy amzguard.env without evaluating or displaying values.' > "$collector_tmp"
printf '%s\n' '# Generated from legacy amzguard.env without evaluating or displaying values.' > "$channels_tmp"
printf '%s\n' '# Generated from legacy amzguard.env without evaluating or displaying values.' > "$retention_tmp"
printf '%s\n' '# Product upload is deliberately disabled after legacy migration.' > "$product_upload_tmp"

append_last_or_default() {
  requested_key=$1
  fallback_value=$2
  output_file=$3
  if ! awk -v requested_key="$requested_key" '
    index($0, requested_key "=") == 1 { last = $0; found = 1 }
    END { if (found) { print last; exit 0 } exit 1 }
  ' "$legacy_env" >> "$output_file"; then
    printf '%s=%s\n' "$requested_key" "$fallback_value" >> "$output_file"
  fi
}

append_renamed_or_default() {
  output_key=$1
  legacy_alias=$2
  fallback_value=$3
  output_file=$4
  if ! awk -v output_key="$output_key" -v legacy_alias="$legacy_alias" '
    index($0, output_key "=") == 1 { preferred = $0; preferred_found = 1 }
    index($0, legacy_alias "=") == 1 { aliased = $0; alias_found = 1 }
    END {
      if (preferred_found) line = preferred
      else if (alias_found) line = aliased
      else exit 1
      print output_key "=" substr(line, index(line, "=") + 1)
    }
  ' "$legacy_env" >> "$output_file"; then
    printf '%s=%s\n' "$output_key" "$fallback_value" >> "$output_file"
  fi
}

legacy_key_has_value() {
  requested_key=$1
  awk -v requested_key="$requested_key" '
    index($0, requested_key "=") == 1 {
      value = substr($0, length(requested_key) + 2)
      found = 1
    }
    END {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (found && value != "" && value != "\"\"" && value != "\047\047") exit 0
      exit 1
    }
  ' "$legacy_env"
}

printf '%s\n' \
  'NODE_ENV=production' \
  'HOST=127.0.0.1' \
  'PORT=4173' \
  'TRUST_PROXY=1' >> "$dashboard_tmp"
for key_default in \
  'DASHBOARD_USERNAME admin' \
  'DASHBOARD_PASSWORD ' \
  'DASHBOARD_SESSION_SECRET ' \
  'REPORT_STALE_HOURS 36'; do
  key=${key_default%% *}
  default=${key_default#* }
  append_last_or_default "$key" "$default" "$dashboard_tmp"
done
append_renamed_or_default AMZGUARD_INGEST_TOKEN INGEST_TOKEN '' "$dashboard_tmp"
printf '%s\n' 'COLLECTOR_HEALTH_REQUIRED=1' >> "$dashboard_tmp"

if legacy_key_has_value ZINIAO_COMPANY \
  && legacy_key_has_value ZINIAO_USERNAME \
  && legacy_key_has_value ZINIAO_PASSWORD; then
  printf '%s\n' 'AMZGUARD_ZINIAO_CONFIGURED=1' >> "$dashboard_tmp"
else
  printf '%s\n' 'AMZGUARD_ZINIAO_CONFIGURED=0' >> "$dashboard_tmp"
fi
if legacy_key_has_value DINGTALK_WEBHOOK && legacy_key_has_value DINGTALK_SECRET; then
  printf '%s\n' 'AMZGUARD_DINGTALK_CONFIGURED=1' >> "$dashboard_tmp"
else
  printf '%s\n' 'AMZGUARD_DINGTALK_CONFIGURED=0' >> "$dashboard_tmp"
fi
if legacy_key_has_value CRM_ENDPOINT && legacy_key_has_value CRM_TOKEN; then
  printf '%s\n' 'AMZGUARD_CRM_CONFIGURED=1' >> "$dashboard_tmp"
else
  printf '%s\n' 'AMZGUARD_CRM_CONFIGURED=0' >> "$dashboard_tmp"
fi

printf '%s\n' \
  'ZINIAO_CLIENT_PATH=/opt/ziniao/ziniaobrowser' \
  'ZINIAO_SOCKET_PORT=18888' >> "$ziniao_tmp"

printf '%s\n' \
  'NODE_ENV=production' \
  'ZINIAO_MODE=webdriver' \
  'ZINIAO_CLIENT_PATH=/opt/ziniao/ziniaobrowser' \
  'ZINIAO_SOCKET_PORT=18888' >> "$collector_tmp"
for key_default in \
  'ZINIAO_CHROMEDRIVER ' \
  'ZINIAO_BIN ziniao-cli' \
  'ZINIAO_COMPANY ' \
  'ZINIAO_USERNAME ' \
  'ZINIAO_PASSWORD ' \
  'LOG_LEVEL info'; do
  key=${key_default%% *}
  default=${key_default#* }
  append_last_or_default "$key" "$default" "$collector_tmp"
done

printf '%s\n' 'DASHBOARD_PUBLIC_URL=https://amzcheck.pc51.com' >> "$channels_tmp"
for key_default in \
  'DINGTALK_WEBHOOK ' \
  'DINGTALK_SECRET ' \
  'DINGTALK_OPS_WEBHOOK ' \
  'DINGTALK_OPS_SECRET ' \
  'CRM_ENDPOINT ' \
  'CRM_TOKEN '; do
  key=${key_default%% *}
  default=${key_default#* }
  append_last_or_default "$key" "$default" "$channels_tmp"
done

for key_default in \
  'AMZGUARD_EVIDENCE_RETENTION_DAYS 45' \
  'AMZGUARD_REPORT_RETENTION_DAYS 365' \
  'AMZGUARD_LOG_RETENTION_DAYS 60' \
  'AMZGUARD_AUDIT_RETENTION_DAYS 365' \
  'AMZGUARD_UPLOAD_PAYLOAD_RETENTION_DAYS 7'; do
  key=${key_default%% *}
  default=${key_default#* }
  append_last_or_default "$key" "$default" "$retention_tmp"
done

printf '%s\n' \
  'AMZGUARD_PRODUCT_UPLOAD_ENABLED=0' \
  'AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED=0' \
  'AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME=' \
  'AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH=/usr/bin/clamscan' \
  'AMZGUARD_PRODUCT_UPLOAD_SIGNATURE_MAX_AGE_DAYS=7' >> "$product_upload_tmp"

for generated_file in "$dashboard_tmp" "$ziniao_tmp" "$collector_tmp" "$channels_tmp" "$retention_tmp" "$product_upload_tmp"; do
  chown root:root "$generated_file"
  chmod 0600 "$generated_file"
done

mv "$dashboard_tmp" "$dashboard_env"
mv "$ziniao_tmp" "$ziniao_env"
mv "$collector_tmp" "$collector_env"
mv "$channels_tmp" "$channels_env"
mv "$retention_tmp" "$retention_env"
mv "$product_upload_tmp" "$product_upload_env"
migration_committed=1
trap - EXIT HUP INT TERM

# The legacy file intentionally remains root-only in place for rollback. New
# units do not reference it; remove it only after the approved rollback window.
echo "EnvironmentFile 已按最小权限拆分；未输出任何值。旧文件仅保留用于回滚。"
