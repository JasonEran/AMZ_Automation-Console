#!/bin/sh
set -eu
export LC_ALL=C

app_dir=/opt/amzguard
env_dir=/etc/amzguard
public_url=https://amzcheck.pc51.com

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行 deploy/verify-linux.sh" >&2
  exit 2
fi

for command_name in cmp find grep readlink sha256sum stat systemctl systemd-analyze nginx logrotate openssl ufw ss curl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || { echo "缺少验收命令: $command_name" >&2; exit 1; }
done
test -x /usr/local/bin/npm || { echo "缺少 /usr/local/bin/npm" >&2; exit 1; }

app_meta=$(stat -c '%U:%G:%a' "$app_dir")
test ! -L "$app_dir" || { echo "部署根目录不得是符号链接" >&2; exit 1; }
[ "$app_meta" = 'root:root:755' ] || { echo "部署根目录权限不合格: $app_meta" >&2; exit 1; }
manifest="$app_dir/DEPLOYED_MANIFEST.sha256"
test -f "$manifest" && test ! -L "$manifest" \
  || { echo "部署清单缺失或类型不安全" >&2; exit 1; }
manifest_meta=$(stat -c '%U:%G:%a' "$manifest")
[ "$manifest_meta" = 'root:root:644' ] \
  || { echo "部署清单权限不合格: $manifest_meta" >&2; exit 1; }
for immutable_root in "$app_dir/src" "$app_dir/scripts" "$app_dir/deploy" "$app_dir/docs" "$app_dir/test"; do
  test -d "$immutable_root" && test ! -L "$immutable_root" \
    || { echo "交付目录缺失或类型不安全" >&2; exit 1; }
  if find "$immutable_root" -xdev \( ! -user root -o ! -group root \) -print | grep -q .; then
    echo "交付目录存在非 root 持有的文件" >&2
    exit 1
  fi
done
for immutable_file in "$app_dir/package.json" "$app_dir/package-lock.json" "$app_dir/README.md" "$app_dir/DEPLOY.md" "$app_dir/AGENTS.md"; do
  immutable_meta=$(stat -c '%U:%G' "$immutable_file")
  [ "$immutable_meta" = 'root:root' ] || { echo "根交付文件属主不合格" >&2; exit 1; }
done

# Syntax-valid but drifted installed files are still a failed deployment.
for unit_source in "$app_dir"/deploy/systemd/*.service "$app_dir"/deploy/systemd/*.timer "$app_dir"/deploy/systemd/*.path; do
  unit_name=$(basename "$unit_source")
  unit_installed="/etc/systemd/system/$unit_name"
  test -f "$unit_installed" && test ! -L "$unit_installed" && cmp -s "$unit_source" "$unit_installed" \
    || { echo "已安装 systemd 单元与交付模板不一致: $unit_name" >&2; exit 1; }
  case "$unit_name" in
    *@.service) loaded_unit=${unit_name%@.service}@env-check.service ;;
    *) loaded_unit=$unit_name ;;
  esac
  [ "$(systemctl show "$loaded_unit" -p NeedDaemonReload --value)" = no ] \
    || { echo "systemd 尚未加载最新模板: $unit_name" >&2; exit 1; }
done
for unit_installed in /etc/systemd/system/amzguard-*.service /etc/systemd/system/amzguard-*.timer /etc/systemd/system/amzguard-*.path; do
  unit_name=$(basename "$unit_installed")
  test -f "$app_dir/deploy/systemd/$unit_name" \
    || { echo "发现未受管 AMZ Guard systemd 单元: $unit_name" >&2; exit 1; }
done
cmp -s "$app_dir/deploy/nginx/amzguard-limit.conf" /etc/nginx/conf.d/amzguard-limit.conf \
  || { echo "已安装 Nginx 限流配置与模板不一致" >&2; exit 1; }
cmp -s "$app_dir/deploy/nginx/amzguard.conf" /etc/nginx/sites-available/amzguard \
  || { echo "已安装 Nginx 站点配置与模板不一致" >&2; exit 1; }
[ "$(readlink -f /etc/nginx/sites-enabled/amzguard)" = /etc/nginx/sites-available/amzguard ] \
  || { echo "Nginx 站点启用链接不正确" >&2; exit 1; }
cmp -s "$app_dir/deploy/logrotate/amzguard" /etc/logrotate.d/amzguard \
  || { echo "已安装 logrotate 配置与模板不一致" >&2; exit 1; }
cmp -s "$app_dir/deploy/polkit/50-amzguard-ziniao-restart.rules" /etc/polkit-1/rules.d/50-amzguard-ziniao-restart.rules \
  || { echo "紫鸟重启授权规则与模板不一致" >&2; exit 1; }
grep -Fxq 'OnCalendar=*-*-* 08:00:00 Asia/Shanghai' /etc/systemd/system/amzguard-store-health-am.timer
grep -Fxq 'OnCalendar=*-*-* 11:20:00 Asia/Shanghai' /etc/systemd/system/amzguard-store-health-ads-off.timer
grep -Fxq 'OnCalendar=*-*-* 15:30:00 Asia/Shanghai' /etc/systemd/system/amzguard-store-health-pm.timer
grep -Fxq 'OnCalendar=*-*-* 18:30:00 Asia/Shanghai' /etc/systemd/system/amzguard-store-health-ads-on.timer

for service in nginx.service amzguard-xvfb.service amzguard-ziniao.service amzguard-dashboard.service; do
  systemctl is-enabled --quiet "$service"
  systemctl is-active --quiet "$service"
done

for timer in \
  amzguard-store-health-am.timer \
  amzguard-store-health-pm.timer \
  amzguard-store-health-ads-off.timer \
  amzguard-store-health-ads-on.timer \
  amzguard-collector-health.timer \
  amzguard-retention.timer \
  amzguard-intelligence.timer \
  amzguard-cert-renew.timer; do
  systemctl is-enabled --quiet "$timer"
  systemctl is-active --quiet "$timer"
done

systemd-analyze verify /etc/systemd/system/amzguard-*.service /etc/systemd/system/amzguard-*.timer /etc/systemd/system/amzguard-*.path

if systemctl list-units --state=failed --no-legend 'amzguard-*' | grep -q .; then
  echo "存在 failed 的 AMZ Guard 单元" >&2
  systemctl list-units --state=failed --no-pager 'amzguard-*'
  exit 1
fi

nginx -t
if ! logrotate --debug /etc/logrotate.conf >/dev/null 2>&1; then
  logrotate --debug /etc/logrotate.conf
  exit 1
fi
test -r /proc/sys/kernel/yama/ptrace_scope || { echo "内核缺少 Yama ptrace_scope" >&2; exit 1; }
# procfs scalar files may have no trailing newline; awk still exits cleanly.
ptrace_scope=$(awk 'NR == 1 { print; exit }' /proc/sys/kernel/yama/ptrace_scope)
case "$ptrace_scope" in ''|*[!0-9]*) echo "无法判定 Yama ptrace_scope" >&2; exit 1;; esac
[ "$ptrace_scope" -ge 2 ] || { echo "Yama ptrace_scope 必须至少为 2" >&2; exit 1; }

env_dir_meta=$(stat -c '%U:%G:%a' "$env_dir")
test ! -L "$env_dir" || { echo "EnvironmentFile 目录不得是符号链接" >&2; exit 1; }
[ "$env_dir_meta" = 'root:root:700' ] \
  || { echo "EnvironmentFile 目录权限不合格: $env_dir_meta" >&2; exit 1; }
for env_name in dashboard ziniao collector channels retention product-upload; do
  test ! -L "$env_dir/$env_name.env" \
    || { echo "EnvironmentFile 不得是符号链接: $env_name.env" >&2; exit 1; }
  env_meta=$(stat -c '%U:%G:%a' "$env_dir/$env_name.env")
  [ "$env_meta" = 'root:root:600' ] \
    || { echo "EnvironmentFile 权限不合格: $env_name.env:$env_meta" >&2; exit 1; }
done
upload_enabled=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_ENABLED" { print $2; exit }' "$env_dir/product-upload.env")
upload_execution_enabled=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED" { print $2; exit }' "$env_dir/product-upload.env")
signature_age_days=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_SIGNATURE_MAX_AGE_DAYS" { print $2; exit }' "$env_dir/product-upload.env")
case "$signature_age_days" in ''|*[!0-9]*) echo "ClamAV 签名年龄配置无效" >&2; exit 1;; esac
[ "$signature_age_days" -ge 1 ] && [ "$signature_age_days" -le 30 ] \
  || { echo "ClamAV 签名年龄配置超出 1 到 30 天" >&2; exit 1; }
case "$upload_enabled:$upload_execution_enabled" in
  0:0)
    ! systemctl is-enabled --quiet amzguard-product-upload.path
    ! systemctl is-enabled --quiet amzguard-product-upload.timer
    ! systemctl is-active --quiet amzguard-product-upload.path
    ! systemctl is-active --quiet amzguard-product-upload.timer
    ;;
  1:1)
    systemctl is-enabled --quiet amzguard-product-upload.path
    systemctl is-active --quiet amzguard-product-upload.path
    systemctl is-enabled --quiet amzguard-product-upload.timer
    systemctl is-active --quiet amzguard-product-upload.timer
    clamscan_path=$(awk -F= '$1 == "AMZGUARD_PRODUCT_UPLOAD_CLAMSCAN_PATH" { print $2; exit }' "$env_dir/product-upload.env")
    test -x "$clamscan_path" || { echo "商品上传已启用但 ClamAV 不可用" >&2; exit 1; }
    find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' \) -mtime "-$signature_age_days" -print | grep -q . \
      || { echo "商品上传已启用但 ClamAV 签名缺失或过期" >&2; exit 1; }
    ;;
  *) echo "商品上传双闸配置不一致" >&2; exit 1 ;;
esac
if grep -R -Eq '^EnvironmentFile=.*amzguard\.env$' /etc/systemd/system/amzguard-*.service; then
  echo "已安装 unit 仍引用旧全量 amzguard.env" >&2
  exit 1
fi
out_meta=$(stat -c '%U:%G:%a' "$app_dir/out")
test ! -L "$app_dir/out" || { echo "out 目录不得是符号链接" >&2; exit 1; }
[ "$out_meta" = 'ubuntu:ubuntu:700' ] || { echo "out 目录权限不合格: $out_meta" >&2; exit 1; }
config_meta=$(stat -c '%U:%G:%a' "$app_dir/config")
test ! -L "$app_dir/config" || { echo "config 目录不得是符号链接" >&2; exit 1; }
[ "$config_meta" = 'root:ubuntu:750' ] || { echo "config 目录权限不合格: $config_meta" >&2; exit 1; }
for config_name in config stores asins; do
  test ! -L "$app_dir/config/$config_name.json" \
    || { echo "运行配置不得是符号链接: $config_name.json" >&2; exit 1; }
  runtime_meta=$(stat -c '%U:%G:%a' "$app_dir/config/$config_name.json")
  [ "$runtime_meta" = 'ubuntu:ubuntu:600' ] \
    || { echo "运行配置权限不合格: $config_name.json:$runtime_meta" >&2; exit 1; }
done
for private_dir in \
  /home/ubuntu/.cache/dconf \
  /home/ubuntu/.cache/ziniaobrowser \
  /home/ubuntu/.config/chromium \
  /home/ubuntu/.config/ziniaobrowser \
  /home/ubuntu/.config/ziniaobrowser-kernel \
  /home/ubuntu/.config/ziniaobrowserdatas \
  /home/ubuntu/.pki; do
  test ! -L "$private_dir" || { echo "紫鸟私有目录不得是符号链接: $private_dir" >&2; exit 1; }
  private_meta=$(stat -c '%U:%G:%a' "$private_dir")
  [ "$private_meta" = 'ubuntu:ubuntu:700' ] \
    || { echo "紫鸟私有目录权限不合格: $private_dir:$private_meta" >&2; exit 1; }
done

for hardened_service in /etc/systemd/system/amzguard-*.service; do
  hardened_unit=$(basename "$hardened_service")
  case "$hardened_unit" in
    *@.service) inspected_unit=${hardened_unit%@.service}@env-check.service ;;
    *) inspected_unit=$hardened_unit ;;
  esac
  [ "$(systemctl show "$inspected_unit" -p ProtectSystem --value)" = strict ] \
    || { echo "服务未启用 ProtectSystem=strict: $hardened_unit" >&2; exit 1; }
  [ -z "$(systemctl show "$inspected_unit" -p DropInPaths --value)" ] \
    || { echo "服务存在未授权 systemd drop-in: $hardened_unit" >&2; exit 1; }
done
assert_environment_files() {
  target_unit=$1
  expected_files=$2
  # Normalize systemd's version-dependent whitespace between multiple files.
  actual_files=$(systemctl show "$target_unit" -p EnvironmentFiles --value \
    | awk 'NF { printf "%s%s", separator, $0; separator = " " }')
  [ "$actual_files" = "$expected_files" ] \
    || { echo "systemd EnvironmentFile 权限边界不符合模板: $target_unit" >&2; exit 1; }
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
for nginx_log in /var/log/nginx/amzguard.access.log /var/log/nginx/amzguard.error.log; do
  test ! -L "$nginx_log" || { echo "Nginx 日志不得是符号链接: $nginx_log" >&2; exit 1; }
  nginx_log_meta=$(stat -c '%U:%G:%a' "$nginx_log")
  [ "$nginx_log_meta" = 'www-data:adm:640' ] \
    || { echo "Nginx 日志权限不合格: $nginx_log:$nginx_log_meta" >&2; exit 1; }
done

listen_4173=$(ss -H -ltn | awk '$4 ~ /:4173$/ {print $4}')
[ "$listen_4173" = '127.0.0.1:4173' ] || { echo "Dashboard 未严格监听 127.0.0.1:4173" >&2; exit 1; }

ufw_status=$(ufw status verbose)
printf '%s\n' "$ufw_status" | grep -q '^Status: active$'
printf '%s\n' "$ufw_status" | grep -q '^Default: deny (incoming)'
if printf '%s\n' "$ufw_status" | grep -Eq '^18888(/tcp)?[[:space:]].*ALLOW'; then
  echo "UFW 不得允许公网 18888" >&2
  exit 1
fi

listener_pids=$(ss -H -ltnp 'sport = :18888' 2>/dev/null \
  | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
[ -n "$listener_pids" ] || { echo "紫鸟 WebDriver 未监听 18888" >&2; exit 1; }
for listener_pid in $listener_pids; do
  [ "$(stat -c %U "/proc/$listener_pid")" = ubuntu ] \
    || { echo "18888 监听进程不是 ubuntu 用户" >&2; exit 1; }
  listener_exe=$(readlink "/proc/$listener_pid/exe" 2>/dev/null || true)
  case "$listener_exe" in /opt/ziniao/*) ;; *) echo "18888 不是紫鸟进程监听" >&2; exit 1;; esac
  grep -q 'amzguard-ziniao.service' "/proc/$listener_pid/cgroup" \
    || { echo "18888 监听进程不属于 amzguard-ziniao.service" >&2; exit 1; }
done
for process_dir in /proc/[0-9]*; do
  test -r "$process_dir/exe" || continue
  process_exe=$(readlink "$process_dir/exe" 2>/dev/null || true)
  case "$process_exe" in
    /opt/ziniao/*)
      grep -q 'amzguard-ziniao.service' "$process_dir/cgroup" 2>/dev/null \
        || { echo "检测到非 systemd 管理的普通紫鸟进程" >&2; exit 1; }
      ;;
  esac
done

health_code=$(curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/api/health)
[ "$health_code" = '200' ] || { echo "Dashboard health HTTP $health_code" >&2; exit 1; }
root_code=$(curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$public_url/")
[ "$root_code" = '200' ] || { echo "未登录主页 HTTP $root_code（期望直接呈现登录页 200）" >&2; exit 1; }
status_code=$(curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$public_url/api/status")
[ "$status_code" = '401' ] || { echo "未登录状态 API HTTP $status_code（期望 401）" >&2; exit 1; }
upload_code=$(curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$public_url/api/product-uploads")
[ "$upload_code" = '401' ] || { echo "未登录商品上传 API HTTP $upload_code（期望 401）" >&2; exit 1; }
ingest_code=$(curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$public_url/api/ingest")
[ "$ingest_code" = '404' ] || { echo "公网 ingest HTTP $ingest_code（期望 404）" >&2; exit 1; }

cert=/etc/letsencrypt/live/123.58.218.45/fullchain.pem
openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$cert" -noout -ext subjectAltName | grep -q 'IP Address:123.58.218.45'
domain_cert=/etc/amzguard/tls/amzcheck.pc51.com/fullchain.pem
domain_key=/etc/amzguard/tls/amzcheck.pc51.com/privkey.pem
test -r "$domain_cert" && test -r "$domain_key"
[ "$(stat -c '%U:%G:%a' /etc/amzguard/tls/amzcheck.pc51.com)" = 'root:root:700' ] \
  || { echo "amzcheck.pc51.com TLS 目录权限不合格" >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' "$domain_cert")" = 'root:root:644' ] \
  || { echo "amzcheck.pc51.com 证书权限不合格" >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' "$domain_key")" = 'root:root:600' ] \
  || { echo "amzcheck.pc51.com 私钥权限不合格" >&2; exit 1; }
openssl x509 -in "$domain_cert" -noout -checkend 2592000 >/dev/null
openssl x509 -in "$domain_cert" -noout -ext subjectAltName | grep -Eq 'DNS:\*\.pc51\.com|DNS:amzcheck\.pc51\.com'
cert_public_key=$(openssl x509 -in "$domain_cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)
key_public_key=$(openssl pkey -in "$domain_key" -pubout -outform DER | sha256sum | cut -d' ' -f1)
[ "$cert_public_key" = "$key_public_key" ] || { echo "amzcheck.pc51.com 证书与私钥不匹配" >&2; exit 1; }

(cd "$app_dir" && sha256sum -c DEPLOYED_MANIFEST.sha256 >/dev/null)
/usr/local/bin/npm --prefix "$app_dir" ls --omit=dev --depth=0 >/dev/null

echo "AMZ Guard Linux 只读验收通过。"
systemctl list-timers --all --no-pager 'amzguard-*.timer'
