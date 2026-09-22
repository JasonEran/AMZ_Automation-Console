#!/bin/sh
set -eu
export LC_ALL=C

app_dir=/opt/amzguard
env_dir=/etc/amzguard
dashboard_env="$env_dir/dashboard.env"
ziniao_env="$env_dir/ziniao.env"
collector_env="$env_dir/collector.env"
channels_env="$env_dir/channels.env"
retention_env="$env_dir/retention.env"
product_upload_env="$env_dir/product-upload.env"
unit_src="$app_dir/deploy/systemd"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行 deploy/install-linux.sh" >&2
  exit 2
fi

for command_name in systemctl systemd-analyze nginx install find sha256sum curl dbus-run-session Xvfb xauth mcookie xdotool runuser logrotate openssl ufw ss awk stat grep cut sort readlink touch mv sleep cmp mktemp rm rmdir; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "缺少必需命令: $command_name" >&2
    exit 2
  }
done

id ubuntu >/dev/null 2>&1 || { echo "缺少运行用户: ubuntu" >&2; exit 2; }
id www-data >/dev/null 2>&1 || { echo "缺少 Nginx 运行用户: www-data" >&2; exit 2; }
test -x /usr/local/bin/node || { echo "缺少 /usr/local/bin/node" >&2; exit 2; }
test -x /opt/ziniao/ziniaobrowser || { echo "缺少紫鸟 Linux 客户端: /opt/ziniao/ziniaobrowser" >&2; exit 2; }
test -x /opt/certbot-ip/bin/certbot || { echo "缺少 IP 证书续期客户端: /opt/certbot-ip/bin/certbot" >&2; exit 2; }
test ! -L "$app_dir" || { echo "部署根目录不得是符号链接" >&2; exit 2; }
test -d "$app_dir/src" || { echo "部署目录不完整: $app_dir/src" >&2; exit 2; }
test ! -L "$app_dir/config" || { echo "配置目录不得是符号链接" >&2; exit 2; }
test ! -L "$app_dir/out" || { echo "输出目录不得是符号链接" >&2; exit 2; }
test ! -L "$app_dir/DEPLOYED_MANIFEST.sha256" || { echo "部署清单不得是符号链接" >&2; exit 2; }
test -f "$app_dir/config/config.json" || { echo "缺少运行配置: $app_dir/config/config.json" >&2; exit 2; }
test -f "$app_dir/config/stores.json" || { echo "缺少店铺配置: $app_dir/config/stores.json" >&2; exit 2; }
test -f "$app_dir/config/asins.json" || { echo "缺少 ASIN 配置: $app_dir/config/asins.json" >&2; exit 2; }
for runtime_config in "$app_dir/config/config.json" "$app_dir/config/stores.json" "$app_dir/config/asins.json"; do
  test ! -L "$runtime_config" || { echo "运行配置不得是符号链接: $runtime_config" >&2; exit 2; }
done
for example_config in "$app_dir/config/config.example.json" "$app_dir/config/stores.example.json" "$app_dir/config/asins.example.json"; do
  test -f "$example_config" && test ! -L "$example_config" \
    || { echo "缺少或不安全的配置模板" >&2; exit 2; }
done
if find "$app_dir/config" -mindepth 1 -maxdepth 1 \
  ! -name config.json ! -name stores.json ! -name asins.json \
  ! -name config.example.json ! -name stores.example.json ! -name asins.example.json \
  -print | grep -q .; then
  echo "config 目录含未批准的备份或额外文件，拒绝部署" >&2
  exit 2
fi
for release_root in "$app_dir/src" "$app_dir/scripts" "$app_dir/deploy" "$app_dir/docs" "$app_dir/test"; do
  test -d "$release_root" && test ! -L "$release_root" \
    || { echo "交付目录缺失或不是普通目录" >&2; exit 2; }
  if find "$release_root" -type l -print | grep -q .; then
    echo "交付目录含符号链接，拒绝部署" >&2
    exit 2
  fi
  if find "$release_root" -type f -links +1 -print | grep -q .; then
    echo "交付目录含硬链接文件，拒绝部署" >&2
    exit 2
  fi
done
for release_file in "$app_dir/package.json" "$app_dir/package-lock.json" "$app_dir/README.md" "$app_dir/DEPLOY.md" "$app_dir/AGENTS.md"; do
  test -f "$release_file" && test ! -L "$release_file" \
    || { echo "根交付文件缺失或不安全" >&2; exit 2; }
  [ "$(stat -c %h "$release_file")" -eq 1 ] \
    || { echo "根交付文件含硬链接，拒绝部署" >&2; exit 2; }
done
test ! -L "$env_dir" || { echo "EnvironmentFile 目录不得是符号链接" >&2; exit 2; }
install -d -m 0700 -o root -g root "$env_dir"
for protected_env in "$dashboard_env" "$ziniao_env" "$collector_env" "$channels_env" "$retention_env" "$product_upload_env"; do
  test -f "$protected_env" || { echo "缺少最小权限 EnvironmentFile: $protected_env" >&2; exit 2; }
  test ! -L "$protected_env" || { echo "EnvironmentFile 不得是符号链接: $protected_env" >&2; exit 2; }
done
test -r /etc/letsencrypt/live/123.58.218.45/fullchain.pem || { echo "缺少 TLS 证书" >&2; exit 2; }
test -r /etc/letsencrypt/live/123.58.218.45/privkey.pem || { echo "缺少 TLS 私钥" >&2; exit 2; }
test -r /etc/amzguard/tls/amzcheck.pc51.com/fullchain.pem || { echo "缺少 amzcheck.pc51.com TLS 证书" >&2; exit 2; }
test -r /etc/amzguard/tls/amzcheck.pc51.com/privkey.pem || { echo "缺少 amzcheck.pc51.com TLS 私钥" >&2; exit 2; }
test -r /proc/sys/kernel/yama/ptrace_scope || { echo "内核缺少 Yama ptrace_scope" >&2; exit 2; }
# procfs scalar files are not required to end in a newline. dash's `read`
# returns 1 at EOF in that case and `set -e` would abort before validation.
ptrace_scope=$(awk 'NR == 1 { print; exit }' /proc/sys/kernel/yama/ptrace_scope)
case "$ptrace_scope" in ''|*[!0-9]*) echo "无法判定 Yama ptrace_scope" >&2; exit 2;; esac
[ "$ptrace_scope" -ge 2 ] || { echo "Yama ptrace_scope 必须至少为 2" >&2; exit 2; }

ufw_status=$(ufw status verbose)
printf '%s\n' "$ufw_status" | grep -q '^Status: active$' || { echo "UFW 未启用" >&2; exit 2; }
printf '%s\n' "$ufw_status" | grep -q '^Default: deny (incoming)' || { echo "UFW 入站默认策略不是 deny" >&2; exit 2; }
if printf '%s\n' "$ufw_status" | grep -Eq '^18888(/tcp)?[[:space:]].*ALLOW'; then
  echo "UFW 不得允许公网 18888" >&2
  exit 2
fi

# A dedicated host may already have the managed WebDriver service running. Any
# Ziniao executable outside that service cgroup is an ordinary/unmanaged client
# and must be closed by an operator before installation.
for process_dir in /proc/[0-9]*; do
  test -r "$process_dir/exe" || continue
  process_exe=$(readlink "$process_dir/exe" 2>/dev/null || true)
  case "$process_exe" in
    /opt/ziniao/*)
      if ! grep -q 'amzguard-ziniao.service' "$process_dir/cgroup" 2>/dev/null; then
        echo "检测到非 systemd 管理的普通紫鸟进程；请正常退出后重试" >&2
        exit 2
      fi
      ;;
  esac
done

validate_ziniao_listener() {
  listener_required=$1
  listener_pids=$(ss -H -ltnp 'sport = :18888' 2>/dev/null \
    | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
  if [ -z "$listener_pids" ]; then
    [ "$listener_required" = optional ] && return 0
    echo "紫鸟 WebDriver 未监听 18888" >&2
    return 1
  fi
  for listener_pid in $listener_pids; do
    test -r "/proc/$listener_pid/exe" || { echo "18888 监听进程已消失" >&2; return 1; }
    [ "$(stat -c %U "/proc/$listener_pid")" = ubuntu ] \
      || { echo "18888 监听进程不是 ubuntu 用户" >&2; return 1; }
    listener_exe=$(readlink "/proc/$listener_pid/exe" 2>/dev/null || true)
    case "$listener_exe" in /opt/ziniao/*) ;; *) echo "18888 不是紫鸟进程监听" >&2; return 1;; esac
    grep -q 'amzguard-ziniao.service' "/proc/$listener_pid/cgroup" \
      || { echo "18888 监听进程不属于 amzguard-ziniao.service" >&2; return 1; }
  done
}
validate_ziniao_listener optional

guarded_timer_units='
amzguard-store-health-am.timer
amzguard-store-health-pm.timer
amzguard-store-health-ads-off.timer
amzguard-store-health-ads-on.timer
amzguard-collector-health.timer
amzguard-retention.timer
amzguard-cert-renew.timer
amzguard-product-upload.timer
amzguard-intelligence.timer
'
guarded_oneshot_units='
amzguard-store-health-am.service
amzguard-store-health-pm.service
amzguard-store-health-ads-off.service
amzguard-store-health-ads-on.service
amzguard-collector-health.service
amzguard-retention.service
amzguard-cert-renew.service
amzguard-channel-test.service
amzguard-product-upload.service
amzguard-intelligence.service
amzguard-collection-recovery.service
'
guarded_path_units='
amzguard-product-upload.path
'

for guarded_timer in $guarded_timer_units; do
  if systemctl is-active --quiet "$guarded_timer"; then
    echo "发布前必须先停止 timer: $guarded_timer" >&2
    exit 2
  fi
done
for guarded_path in $guarded_path_units; do
  if systemctl is-active --quiet "$guarded_path"; then
    echo "发布前必须先停止 path: $guarded_path" >&2
    exit 2
  fi
done

reject_running_oneshot() {
  running_unit=$1
  active_state=$(systemctl show "$running_unit" -p ActiveState --value 2>/dev/null || true)
  case "$active_state" in
    active|activating)
      echo "相关任务仍在运行（ActiveState=$active_state），拒绝中途部署: $running_unit" >&2
      exit 2
      ;;
  esac
}

for running_unit in $guarded_oneshot_units; do
  reject_running_oneshot "$running_unit"
done

# Type=oneshot remains `activating` for the lifetime of ExecStart, so an
# active-only list misses the exact collection window this gate protects.
manual_units=$(systemctl list-units --type=service --all --no-legend --plain \
  'amzguard-manual@*.service' 2>/dev/null | awk '{print $1}')
for running_unit in $manual_units; do
  reject_running_oneshot "$running_unit"
done

is_guarded_deploy_job_unit() {
  job_candidate=$1
  case "$job_candidate" in
    amzguard-manual@*.service) return 0 ;;
  esac
  for guarded_unit in $guarded_oneshot_units $guarded_timer_units $guarded_path_units; do
    [ "$job_candidate" = "$guarded_unit" ] && return 0
  done
  return 1
}

# A queued start/stop job can sit between the ActiveState snapshot and process
# startup. Reject only collection/manual/maintenance jobs; the always-on
# dashboard, Ziniao, Xvfb and Nginx services are deliberately outside this set.
pending_jobs=$(systemctl list-jobs --no-legend --no-pager)
while read -r job_id job_unit job_type job_state job_remainder; do
  [ -n "${job_unit:-}" ] || continue
  if is_guarded_deploy_job_unit "$job_unit"; then
    echo "发现相关 systemd job，拒绝中途部署: $job_unit" >&2
    exit 2
  fi
done <<EOF
$pending_jobs
EOF

if test -e "$app_dir/out/runtime/run.lock"; then
  echo "发现运行锁，拒绝部署；请先按排障手册确认任务或陈旧锁" >&2
  exit 2
fi
if find /etc/systemd/system /run/systemd/system -type f \
  \( -path '*/amzguard-*.service.d/*' -o -path '*/amzguard-*.timer.d/*' -o -path '*/amzguard-*.path.d/*' \) \
  -print 2>/dev/null | grep -q .; then
  echo "检测到未纳入版本控制的 AMZ Guard systemd drop-in，拒绝部署" >&2
  exit 2
fi

for protected_env in "$dashboard_env" "$ziniao_env" "$collector_env" "$channels_env" "$retention_env" "$product_upload_env"; do
  chmod 0600 "$protected_env"
  chown root:root "$protected_env"
done
validate_env_shape() {
  target_file=$1
  if ! awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    /^[A-Z_][A-Z0-9_]*=/ {
      key = $0
      sub(/=.*/, "", key)
      seen[key] += 1
      next
    }
    { invalid = 1 }
    END {
      for (key in seen) if (seen[key] > 1) invalid = 1
      exit invalid ? 1 : 0
    }
  ' "$target_file"; then
    echo "EnvironmentFile 语法无效或含重复键: $(basename "$target_file")" >&2
    exit 2
  fi
}
require_key() {
  target_file=$1
  required_key=$2
  if ! grep -q "^${required_key}=" "$target_file" \
    || grep -Eq "^${required_key}=(|\"\"|'')$" "$target_file"; then
    echo "EnvironmentFile 缺少必需键: $(basename "$target_file"):$required_key" >&2
    exit 2
  fi
}
require_min_value_length() {
  target_file=$1
  required_key=$2
  minimum_length=$3
  if ! awk -v required_key="$required_key" -v minimum_length="$minimum_length" '
    index($0, required_key "=") == 1 {
      value = substr($0, length(required_key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      exit length(value) >= minimum_length ? 0 : 1
    }
    END { if (NR == 0) exit 1 }
  ' "$target_file"; then
    echo "EnvironmentFile 键长度不足: $(basename "$target_file"):$required_key" >&2
    exit 2
  fi
}
require_exact() {
  target_file=$1
  required_key=$2
  expected_value=$3
  if ! grep -Fxq "${required_key}=${expected_value}" "$target_file"; then
    echo "EnvironmentFile 安全键不符合预期: $(basename "$target_file"):$required_key" >&2
    exit 2
  fi
}
forbid_key() {
  target_file=$1
  forbidden_key=$2
  if grep -q "^${forbidden_key}=" "$target_file"; then
    echo "EnvironmentFile 含越权键: $(basename "$target_file"):$forbidden_key" >&2
    exit 2
  fi
}
key_has_value() {
  target_file=$1
  optional_key=$2
  grep -q "^${optional_key}=" "$target_file" \
    && ! grep -Eq "^${optional_key}=(|\"\"|'')$" "$target_file"
}
require_pair_or_empty() {
  target_file=$1
  first_key=$2
  second_key=$3
  first_set=0
  second_set=0
  key_has_value "$target_file" "$first_key" && first_set=1
  key_has_value "$target_file" "$second_key" && second_set=1
  if [ "$first_set" -ne "$second_set" ]; then
    echo "EnvironmentFile 可选凭据必须成对配置: $(basename "$target_file"):$first_key/$second_key" >&2
    exit 2
  fi
}
for protected_env in "$dashboard_env" "$ziniao_env" "$collector_env" "$channels_env" "$retention_env" "$product_upload_env"; do
  validate_env_shape "$protected_env"
done
for required_key in DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET AMZGUARD_INGEST_TOKEN; do
  require_key "$dashboard_env" "$required_key"
done
require_min_value_length "$dashboard_env" DASHBOARD_PASSWORD 12
require_min_value_length "$dashboard_env" DASHBOARD_SESSION_SECRET 32
require_min_value_length "$dashboard_env" AMZGUARD_INGEST_TOKEN 32
require_exact "$dashboard_env" NODE_ENV production
require_exact "$dashboard_env" HOST 127.0.0.1
require_exact "$dashboard_env" PORT 4173
require_exact "$dashboard_env" TRUST_PROXY 1
require_exact "$dashboard_env" COLLECTOR_HEALTH_REQUIRED 1
require_exact "$dashboard_env" AMZGUARD_ZINIAO_CONFIGURED 1
require_exact "$dashboard_env" AMZGUARD_DINGTALK_CONFIGURED 1
for required_key in ZINIAO_CLIENT_PATH ZINIAO_SOCKET_PORT; do
  require_key "$ziniao_env" "$required_key"
done
require_exact "$ziniao_env" ZINIAO_CLIENT_PATH /opt/ziniao/ziniaobrowser
require_exact "$ziniao_env" ZINIAO_SOCKET_PORT 18888
for required_key in ZINIAO_MODE ZINIAO_CLIENT_PATH ZINIAO_SOCKET_PORT ZINIAO_COMPANY ZINIAO_USERNAME ZINIAO_PASSWORD; do
  require_key "$collector_env" "$required_key"
done
require_exact "$collector_env" NODE_ENV production
require_exact "$collector_env" ZINIAO_MODE webdriver
require_exact "$collector_env" ZINIAO_CLIENT_PATH /opt/ziniao/ziniaobrowser
require_exact "$collector_env" ZINIAO_SOCKET_PORT 18888
for required_key in DASHBOARD_PUBLIC_URL DINGTALK_WEBHOOK DINGTALK_SECRET; do
  require_key "$channels_env" "$required_key"
done
require_exact "$channels_env" DASHBOARD_PUBLIC_URL https://amzcheck.pc51.com
require_pair_or_empty "$channels_env" DINGTALK_OPS_WEBHOOK DINGTALK_OPS_SECRET
require_pair_or_empty "$channels_env" CRM_ENDPOINT CRM_TOKEN
for required_key in AMZGUARD_EVIDENCE_RETENTION_DAYS AMZGUARD_REPORT_RETENTION_DAYS AMZGUARD_LOG_RETENTION_DAYS AMZGUARD_AUDIT_RETENTION_DAYS AMZGUARD_UPLOAD_PAYLOAD_RETENTION_DAYS; do
  require_key "$retention_env" "$required_key"
done
for required_key in AMZGUARD_PRODUCT_UPLOAD_ENABLED AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH AMZGUARD_PRODUCT_UPLOAD_SIGNATURE_MAX_AGE_DAYS; do
  require_key "$product_upload_env" "$required_key"
done
upload_enabled=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_ENABLED" { print $2; exit }' "$product_upload_env")
upload_execution_enabled=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED" { print $2; exit }' "$product_upload_env")
signature_age_days=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_SIGNATURE_MAX_AGE_DAYS" { print $2; exit }' "$product_upload_env")
case "$signature_age_days" in ''|*[!0-9]*) echo "ClamAV 签名年龄必须是正整数天数" >&2; exit 2;; esac
[ "$signature_age_days" -ge 1 ] && [ "$signature_age_days" -le 30 ] \
  || { echo "ClamAV 签名年龄必须在 1 到 30 天之间" >&2; exit 2; }
case "$upload_enabled:$upload_execution_enabled" in
  0:0) ;;
  1:1)
    require_key "$product_upload_env" AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME
    dashboard_username=$(awk -F= '$1 == "DASHBOARD_USERNAME" { print $2; exit }' "$dashboard_env")
    upload_username=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME" { print $2; exit }' "$product_upload_env")
    [ "$dashboard_username" = "$upload_username" ] \
      || { echo "商品上传管理员必须精确匹配 Dashboard 用户名" >&2; exit 2; }
    clamscan_path=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH" { print $2; exit }' "$product_upload_env")
    test -x "$clamscan_path" || { echo "商品上传已启用但 ClamAV 扫描器不可用" >&2; exit 2; }
    find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' \) -mtime "-$signature_age_days" -print | grep -q . \
      || { echo "商品上传已启用但 ClamAV 签名缺失或过期" >&2; exit 2; }
    ;;
  *) echo "商品上传展示与执行双闸必须同时为 0 或同时为 1" >&2; exit 2 ;;
esac

crm_configured=0
if key_has_value "$channels_env" CRM_ENDPOINT && key_has_value "$channels_env" CRM_TOKEN; then
  crm_configured=1
fi
require_exact "$dashboard_env" AMZGUARD_CRM_CONFIGURED "$crm_configured"

# Enforce the least-privilege split by key name without ever reading values.
for forbidden_key in ZINIAO_COMPANY ZINIAO_USERNAME ZINIAO_PASSWORD DINGTALK_WEBHOOK DINGTALK_SECRET DINGTALK_OPS_WEBHOOK DINGTALK_OPS_SECRET CRM_ENDPOINT CRM_TOKEN; do
  forbid_key "$dashboard_env" "$forbidden_key"
done
for forbidden_key in ZINIAO_COMPANY ZINIAO_USERNAME ZINIAO_PASSWORD DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET AMZGUARD_INGEST_TOKEN DINGTALK_WEBHOOK DINGTALK_SECRET CRM_ENDPOINT CRM_TOKEN; do
  forbid_key "$ziniao_env" "$forbidden_key"
done
for forbidden_key in DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET AMZGUARD_INGEST_TOKEN DINGTALK_WEBHOOK DINGTALK_SECRET DINGTALK_OPS_WEBHOOK DINGTALK_OPS_SECRET CRM_ENDPOINT CRM_TOKEN; do
  forbid_key "$collector_env" "$forbidden_key"
done
for forbidden_key in ZINIAO_COMPANY ZINIAO_USERNAME ZINIAO_PASSWORD DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET AMZGUARD_INGEST_TOKEN; do
  forbid_key "$channels_env" "$forbidden_key"
done
for forbidden_key in ZINIAO_COMPANY ZINIAO_USERNAME ZINIAO_PASSWORD DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET AMZGUARD_INGEST_TOKEN DINGTALK_WEBHOOK DINGTALK_SECRET DINGTALK_OPS_WEBHOOK DINGTALK_OPS_SECRET CRM_ENDPOINT CRM_TOKEN; do
  forbid_key "$retention_env" "$forbidden_key"
done
for forbidden_key in ZINIAO_COMPANY ZINIAO_USERNAME ZINIAO_PASSWORD DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET AMZGUARD_INGEST_TOKEN DINGTALK_WEBHOOK DINGTALK_SECRET DINGTALK_OPS_WEBHOOK DINGTALK_OPS_SECRET CRM_ENDPOINT CRM_TOKEN; do
  forbid_key "$product_upload_env" "$forbidden_key"
done

if grep -R -Eq '^EnvironmentFile=.*amzguard\.env$' "$unit_src"; then
  echo "systemd 模板仍引用已停用的全量 amzguard.env" >&2
  exit 2
fi

install -d -m 0700 -o ubuntu -g ubuntu "$app_dir/out"
test ! -L /home/ubuntu/.cache/selenium || { echo "Selenium 缓存不得是符号链接" >&2; exit 2; }
install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.cache/selenium
for private_dir in \
  /home/ubuntu/.cache \
  /home/ubuntu/.cache/dconf \
  /home/ubuntu/.cache/ziniaobrowser \
  /home/ubuntu/.config \
  /home/ubuntu/.config/chromium \
  /home/ubuntu/.config/ziniaobrowser \
  /home/ubuntu/.config/ziniaobrowser/app-cache \
  /home/ubuntu/.config/ziniaobrowser/app-cache/tmp \
  /home/ubuntu/.config/ziniaobrowser-kernel \
  /home/ubuntu/.config/ziniaobrowserdatas \
  /home/ubuntu/.pki; do
  test ! -L "$private_dir" || { echo "紫鸟私有目录不得是符号链接: $private_dir" >&2; exit 2; }
  install -d -m 0700 -o ubuntu -g ubuntu "$private_dir"
done
install -d -m 0755 /var/www/acme
# Application code and deployment templates are immutable to the runtime user.
# Only the three runtime JSON files and out/ remain writable by ubuntu.
find "$app_dir" -xdev \
  \( -path "$app_dir/config" -o -path "$app_dir/out" \) -prune \
  -o -exec chown -h root:root {} +
chmod 0755 "$app_dir"
chmod 0750 "$app_dir/config"
chown root:ubuntu "$app_dir/config"
for example_config in "$app_dir/config/config.example.json" "$app_dir/config/stores.example.json" "$app_dir/config/asins.example.json"; do
  chmod 0640 "$example_config"
  chown root:ubuntu "$example_config"
done
for runtime_config in "$app_dir/config/config.json" "$app_dir/config/stores.json" "$app_dir/config/asins.json"; do
  chmod 0600 "$runtime_config"
  chown ubuntu:ubuntu "$runtime_config"
done
find "$app_dir/out" -type d -exec chmod 0700 {} +
find "$app_dir/out" -type f -exec chmod 0600 {} +
find "$app_dir/out" -type d -exec chown ubuntu:ubuntu {} +
find "$app_dir/out" -type f -exec chown ubuntu:ubuntu {} +
chmod 0755 \
  "$app_dir/deploy/run-ziniao-linux.sh" \
  "$app_dir/deploy/manual-run.sh" \
  "$app_dir/deploy/migrate-env-layout.sh" \
  "$app_dir/deploy/manifest.sh" \
  "$app_dir/deploy/verify-linux.sh"

# Loads only non-secret JSON here; credentials remain under systemd control.
# This makes the deployment fail before restart if a legacy inline secret or
# malformed runtime config slipped onto the host.
runuser -u ubuntu -- /usr/local/bin/node "$app_dir/src/cli.js" checks >/dev/null
systemd-analyze verify "$unit_src"/*.service "$unit_src"/*.timer "$unit_src"/*.path

for source_file in "$unit_src"/*.service "$unit_src"/*.timer "$unit_src"/*.path; do
  install -m 0644 "$source_file" "/etc/systemd/system/$(basename "$source_file")"
done

# Versions before the least-privilege Nginx split used this exact one-line
# filename. Keeping it alongside amzguard-limit.conf defines the same shared
# zone twice and makes nginx -t fail. Migrate only the known managed content;
# an unfamiliar file is operator-owned and must never be overwritten/deleted.
legacy_limit=/etc/nginx/conf.d/amzguard-rate.conf
legacy_limit_disabled=/etc/nginx/conf.d/amzguard-rate.conf.disabled
if test -e "$legacy_limit" || test -L "$legacy_limit"; then
  test -f "$legacy_limit" && test ! -L "$legacy_limit" \
    || { echo "旧 Nginx 限流文件类型异常，拒绝迁移" >&2; exit 2; }
  if ! awk '
    $0 == "limit_req_zone $binary_remote_addr zone=amzguard_login:10m rate=10r/m;" { known += 1 }
    END { exit (NR == 1 && known == 1) ? 0 : 1 }
  ' "$legacy_limit"; then
    echo "旧 Nginx 限流文件不是已知受管版本，拒绝迁移" >&2
    exit 2
  fi
  test ! -e "$legacy_limit_disabled" && test ! -L "$legacy_limit_disabled" \
    || { echo "旧 Nginx 限流备份目标已存在，拒绝覆盖" >&2; exit 2; }
  mv "$legacy_limit" "$legacy_limit_disabled"
fi
install -m 0644 "$app_dir/deploy/nginx/amzguard-limit.conf" /etc/nginx/conf.d/amzguard-limit.conf
install -m 0644 "$app_dir/deploy/nginx/amzguard.conf" /etc/nginx/sites-available/amzguard

# The first certificate request uses a deliberately HTTP-only bootstrap site.
# Disable only the exact managed symlink before enabling the final HTTPS site;
# an unexpected regular file remains operator-owned and fails closed.
bootstrap_enabled=/etc/nginx/sites-enabled/amzguard-acme-bootstrap.conf
if test -e "$bootstrap_enabled" || test -L "$bootstrap_enabled"; then
  test -L "$bootstrap_enabled" \
    && [ "$(readlink "$bootstrap_enabled")" = /etc/nginx/sites-available/amzguard-acme-bootstrap.conf ] \
    || { echo "HTTPS 引导站点类型或目标异常，拒绝覆盖" >&2; exit 2; }
  rm "$bootstrap_enabled"
fi
ln -sfn /etc/nginx/sites-available/amzguard /etc/nginx/sites-enabled/amzguard
install -m 0644 "$app_dir/deploy/logrotate/amzguard" /etc/logrotate.d/amzguard
install -d -m 0755 /etc/polkit-1/rules.d
install -m 0644 "$app_dir/deploy/polkit/50-amzguard-ziniao-restart.rules" /etc/polkit-1/rules.d/50-amzguard-ziniao-restart.rules

for nginx_log in /var/log/nginx/amzguard.access.log /var/log/nginx/amzguard.error.log; do
  test ! -L "$nginx_log" || { echo "Nginx 日志不得是符号链接: $nginx_log" >&2; exit 2; }
  touch "$nginx_log"
  chown www-data:adm "$nginx_log"
  chmod 0640 "$nginx_log"
done

nginx -t
# Parse the global configuration so duplicate globs across distro and product
# snippets fail the deployment gate. Nginx logs remain owned by its packaged
# /etc/logrotate.d/nginx policy; this file covers application logs only.
if ! logrotate --debug /etc/logrotate.conf >/dev/null 2>&1; then
  logrotate --debug /etc/logrotate.conf
  exit 2
fi
systemctl daemon-reload
assert_environment_files() {
  target_unit=$1
  expected_files=$2
  # systemd versions render multiple EnvironmentFiles either space- or
  # newline-separated. Normalize presentation while preserving exact order.
  actual_files=$(systemctl show "$target_unit" -p EnvironmentFiles --value \
    | awk 'NF { printf "%s%s", separator, $0; separator = " " }')
  if [ "$actual_files" != "$expected_files" ]; then
    echo "systemd EnvironmentFile 权限边界不符合模板: $target_unit" >&2
    exit 2
  fi
}
assert_environment_files amzguard-intelligence.service '/etc/amzguard/collector.env (ignore_errors=no)'
assert_environment_files amzguard-dashboard.service '/etc/amzguard/dashboard.env (ignore_errors=no) /etc/amzguard/product-upload.env (ignore_errors=no)'
assert_environment_files amzguard-ziniao.service '/etc/amzguard/ziniao.env (ignore_errors=no)'
assert_environment_files amzguard-collector-health.service '/etc/amzguard/collector.env (ignore_errors=no) /etc/amzguard/channels.env (ignore_errors=no)'
assert_environment_files amzguard-retention.service '/etc/amzguard/retention.env (ignore_errors=no)'
assert_environment_files amzguard-channel-test.service '/etc/amzguard/channels.env (ignore_errors=no)'
assert_environment_files amzguard-manual@env-check.service '/etc/amzguard/collector.env (ignore_errors=no) /etc/amzguard/channels.env (ignore_errors=no)'
assert_environment_files amzguard-product-upload.service '/etc/amzguard/collector.env (ignore_errors=no) /etc/amzguard/channels.env (ignore_errors=no) /etc/amzguard/product-upload.env (ignore_errors=no)'
for business_unit in \
  amzguard-store-health-am.service \
  amzguard-store-health-pm.service \
  amzguard-store-health-ads-off.service \
  amzguard-store-health-ads-on.service; do
  assert_environment_files "$business_unit" '/etc/amzguard/collector.env (ignore_errors=no) /etc/amzguard/channels.env (ignore_errors=no)'
done
assert_environment_files amzguard-xvfb.service ''
assert_environment_files amzguard-cert-renew.service ''

# Build the trust anchor in a root-only directory, then atomically replace the
# destination. Shell redirection must never target the ubuntu-writable release
# directory directly because it follows a concurrently swapped symlink.
manifest="$app_dir/DEPLOYED_MANIFEST.sha256"
manifest_stage=$(mktemp -d /run/amzguard-manifest.XXXXXX)
chmod 0700 "$manifest_stage"
manifest_tmp="$manifest_stage/manifest.sha256"
if ! "$app_dir/deploy/manifest.sh" "$app_dir" > "$manifest_tmp"; then
  rm -f "$manifest_tmp"
  rmdir "$manifest_stage" 2>/dev/null || true
  echo "无法生成部署清单" >&2
  exit 2
fi
chmod 0644 "$manifest_tmp"
chown root:root "$manifest_tmp"
mv -T "$manifest_tmp" "$manifest"
rmdir "$manifest_stage"
chmod 0644 "$manifest"
chown root:root "$manifest"
(cd "$app_dir" && sha256sum -c DEPLOYED_MANIFEST.sha256 >/dev/null)

systemctl enable nginx.service amzguard-xvfb.service amzguard-ziniao.service amzguard-dashboard.service
systemctl enable amzguard-store-health-am.timer amzguard-store-health-pm.timer
systemctl enable amzguard-store-health-ads-off.timer amzguard-store-health-ads-on.timer
systemctl enable amzguard-collector-health.timer amzguard-retention.timer
systemctl enable amzguard-cert-renew.timer amzguard-intelligence.timer
if [ "$upload_enabled" = 1 ]; then
  install -d -m 0700 -o ubuntu -g ubuntu "$app_dir/out/product-uploads/queue"
  systemctl enable amzguard-product-upload.path amzguard-product-upload.timer
else
  systemctl disable --now amzguard-product-upload.path amzguard-product-upload.timer >/dev/null 2>&1 || true
fi

systemctl restart amzguard-xvfb.service
systemctl restart amzguard-ziniao.service
systemctl restart amzguard-dashboard.service
systemctl restart nginx.service
systemctl start amzguard-store-health-am.timer amzguard-store-health-pm.timer
systemctl start amzguard-store-health-ads-off.timer amzguard-store-health-ads-on.timer
systemctl start amzguard-collector-health.timer amzguard-retention.timer
systemctl start amzguard-cert-renew.timer amzguard-intelligence.timer
if [ "$upload_enabled" = 1 ]; then
  systemctl start amzguard-product-upload.path amzguard-product-upload.timer
fi

systemctl is-active --quiet amzguard-xvfb.service
systemctl is-active --quiet amzguard-ziniao.service
systemctl is-active --quiet amzguard-dashboard.service
systemctl is-active --quiet nginx.service

# Type=simple becomes active before the Electron child has bound its HTTP
# socket. Wait for the complete owner/executable/cgroup assertion instead of
# racing service startup; retain a hard upper bound and the original failure.
listener_ready=0
listener_attempt=0
while [ "$listener_attempt" -lt 120 ]; do
  if validate_ziniao_listener required >/dev/null 2>&1; then
    listener_ready=1
    break
  fi
  listener_attempt=$((listener_attempt + 1))
  sleep 1
done
[ "$listener_ready" -eq 1 ] || validate_ziniao_listener required

echo "AMZ Guard systemd、Nginx、权限与版本清单安装完成。"
