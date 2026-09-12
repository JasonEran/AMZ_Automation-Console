#!/usr/bin/env bash
# Build a reproducible Linux deployment archive without runtime data or secrets.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p dist
pack_tmp_dir=$(mktemp -d /tmp/amzguard-pack.XXXXXX)
pack_tmp_zip="$pack_tmp_dir/amzguard.zip"
pack_entry_list="$pack_tmp_dir/entries.txt"
pack_zipinfo_file="$pack_tmp_dir/zipinfo.txt"
pack_scan_file="$pack_tmp_dir/content.scan"
pack_findings_file="$pack_tmp_dir/findings.txt"
cleanup() {
  rm -f "$pack_tmp_zip" "$pack_entry_list" "$pack_zipinfo_file" "$pack_scan_file" "$pack_findings_file"
  rmdir "$pack_tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

pack_roots=(src scripts deploy docs test)
pack_config_files=(config/config.example.json config/stores.example.json config/asins.example.json)
pack_inputs=("${pack_roots[@]}" "${pack_config_files[@]}")
pack_root_files=(package.json package-lock.json README.md DEPLOY.md AGENTS.md .gitignore)

# `zip` may follow a symlink and archive bytes outside the repository. Release
# inputs therefore reject every symlink instead of trying to infer whether its
# target is harmless. Root files must also be ordinary files.
if ! find "${pack_inputs[@]}" -type l -print > "$pack_findings_file"; then
  echo "打包安全检查失败：无法完成符号链接检查" >&2
  exit 2
fi
if [[ -s "$pack_findings_file" ]]; then
  echo "打包安全检查失败：交付目录含符号链接" >&2
  exit 2
fi

# A hard link can make an innocent-looking release path expose bytes from a
# file outside the repository. Release inputs must each have one directory
# entry only; links within the repository are rejected as well for clarity.
if ! find "${pack_inputs[@]}" -type f -links +1 -print > "$pack_findings_file"; then
  echo "打包安全检查失败：无法完成硬链接检查" >&2
  exit 2
fi
if [[ -s "$pack_findings_file" ]]; then
  echo "打包安全检查失败：交付目录含硬链接文件" >&2
  exit 2
fi
for pack_root_file in "${pack_root_files[@]}"; do
  if [[ -L "$pack_root_file" || ! -f "$pack_root_file" ]]; then
    echo "打包安全检查失败：根交付文件缺失或不是普通文件" >&2
    exit 2
  fi
  if pack_link_count=$(stat -c '%h' "$pack_root_file" 2>/dev/null); then
    :
  elif pack_link_count=$(stat -f '%l' "$pack_root_file" 2>/dev/null); then
    :
  else
    echo "打包安全检查失败：无法读取根交付文件链接数" >&2
    exit 2
  fi
  if [[ ! "$pack_link_count" =~ ^[0-9]+$ || "$pack_link_count" -ne 1 ]]; then
    echo "打包安全检查失败：根交付文件含硬链接" >&2
    exit 2
  fi
done

# Refuse likely secret containers case-insensitively, including nested files.
# Example templates such as `amzguard.env.example` do not end in `.env` and are
# intentionally allowed; a real `.env`, key or certificate bundle is not.
if ! find "${pack_inputs[@]}" \( -type f -o -type l \) \( \
  -iname '.env' -o -iname '.env.*' -o -iname '*.env' \
  -o -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' \
\) -print > "$pack_findings_file"; then
  echo "打包安全检查失败：无法完成秘密文件类型检查" >&2
  exit 2
fi
if [[ -s "$pack_findings_file" ]]; then
  echo "打包安全检查失败：交付目录含禁止的秘密文件类型" >&2
  exit 2
fi

# Store links as links so a path swapped after preflight cannot make `zip`
# follow it and silently archive bytes from outside the release tree. The
# post-build check below then rejects every stored link.
zip -qry -y "$pack_tmp_zip" "${pack_inputs[@]}" "${pack_root_files[@]}" \
  -x '*/out/*' -x '*/node_modules/*' -x '*/dist/*' -x '*.DS_Store' -x '*/._*'

if ! unzip -Z1 "$pack_tmp_zip" > "$pack_entry_list"; then
  echo "打包安全检查失败：无法读取归档目录" >&2
  exit 2
fi
if grep -Eiq \
  '^config/(config|stores|asins)\.json$|(^|/)(out|node_modules|dist|\.git)(/|$)|(^|/)\.env($|\.)|\.(env|pem|key|p12|pfx)$' \
  "$pack_entry_list"; then
  echo "打包安全检查失败：归档包含运行配置、输出、依赖或秘密文件类型" >&2
  exit 2
else
  pack_entry_scan_status=$?
  if [[ "$pack_entry_scan_status" -ne 1 ]]; then
    echo "打包安全检查失败：无法完成归档条目安全检查" >&2
    exit 2
  fi
fi
if ! zipinfo -l "$pack_tmp_zip" > "$pack_zipinfo_file"; then
  echo "打包安全检查失败：无法读取归档文件类型" >&2
  exit 2
fi
if LC_ALL=C grep -Eq '^l' "$pack_zipinfo_file"; then
  echo "打包安全检查失败：归档包含符号链接" >&2
  exit 2
else
  pack_link_scan_status=$?
  if [[ "$pack_link_scan_status" -ne 1 ]]; then
    echo "打包安全检查失败：无法完成归档符号链接检查" >&2
    exit 2
  fi
fi

# Scan the bytes that will actually ship. Patterns are deliberately
# high-confidence to avoid dumping or flagging ordinary fixture vocabulary.
# Split the most recognisable literals so this scanner does not match itself.
private_key_re='-----BEGIN (RSA |OPENSSH |EC |ENCRYPTED )?PRIV''ATE KEY-----'
dingtalk_token_re='https://oapi\.dingtalk\.com/robot/send\?access_''token=[A-Za-z0-9_-]{16,}'
credential_assignment_re='^(ZINIAO_(COMPANY|USERNAME|PASSWORD)|DINGTALK_(WEBHOOK|SECRET|OPS_WEBHOOK|OPS_SECRET)|CRM_(TOKEN|ENDPOINT)|DASHBOARD_(PASSWORD|SESSION_SECRET)|AMZGUARD_INGEST_TOKEN)=.{8,}$'
high_confidence_re="${private_key_re}|${dingtalk_token_re}|SEC[0-9A-Fa-f]{32,}|(AKIA|ASIA)[A-Z0-9]{16}|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{20,}|${credential_assignment_re}"
while IFS= read -r pack_entry; do
  [[ "$pack_entry" == */ ]] && continue
  if ! unzip -p "$pack_tmp_zip" "$pack_entry" > "$pack_scan_file"; then
    echo "打包安全检查失败：无法读取归档内容" >&2
    exit 2
  fi
  if LC_ALL=C grep -Eaq -e "$high_confidence_re" "$pack_scan_file"; then
    echo "打包安全检查失败：归档内容命中高置信凭据模式" >&2
    exit 2
  else
    pack_scan_status=$?
    if [[ "$pack_scan_status" -ne 1 ]]; then
      echo "打包安全检查失败：归档内容扫描器执行异常" >&2
      exit 2
    fi
  fi
done < "$pack_entry_list"

install -m 0600 "$pack_tmp_zip" dist/amzguard.zip
echo "dist/amzguard.zip  $(du -h dist/amzguard.zip | cut -f1)  ($(unzip -Z1 dist/amzguard.zip | wc -l | tr -d ' ') 个文件)"
