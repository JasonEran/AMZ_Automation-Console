#!/bin/sh
set -eu

app_dir=${1:-/opt/amzguard}

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1"; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1"; }
else
  echo "缺少 SHA-256 工具" >&2
  exit 2
fi

manifest_paths=$(mktemp "${TMPDIR:-/tmp}/amzguard-manifest.XXXXXX")
trap 'rm -f "$manifest_paths"' EXIT HUP INT TERM

(
  cd "$app_dir"
  find src scripts deploy docs test .github -type f ! -name '._*' ! -name '.DS_Store' -print
  find config -maxdepth 1 -type f -name '*.example.json' ! -name '._*' -print
  find . -maxdepth 1 -type f \( -name 'package.json' -o -name 'package-lock.json' -o -name 'README.md' -o -name 'DEPLOY.md' -o -name 'AGENTS.md' -o -name 'CONTRIBUTING.md' -o -name 'SECURITY.md' -o -name 'CHANGELOG.md' -o -name '.gitignore' \) -print
) > "$manifest_paths"
LC_ALL=C sort -o "$manifest_paths" "$manifest_paths"
while IFS= read -r artifact; do
  artifact=${artifact#./}
  (cd "$app_dir" && digest "$artifact")
done < "$manifest_paths"
