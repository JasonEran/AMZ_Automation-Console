#!/usr/bin/env bash
# Keep every test fixture under one owned directory and remove it on exit. This
# prevents repeated CI/deployment gates from leaking hundreds of /tmp entries.
set -euo pipefail

test_tmp_parent="${TMPDIR:-/tmp}"
test_tmp_dir=$(mktemp -d "${test_tmp_parent%/}/amzguard-test-suite.XXXXXX")

cleanup() {
  case "$test_tmp_dir" in
    "${test_tmp_parent%/}"/amzguard-test-suite.*)
      if [[ -d "$test_tmp_dir" && ! -L "$test_tmp_dir" ]]; then
        rm -rf -- "$test_tmp_dir"
      fi
      ;;
    *)
      echo "测试临时目录安全校验失败，拒绝清理: $test_tmp_dir" >&2
      return 1
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

export TMPDIR="$test_tmp_dir"
node --test test/*.test.js src/selftest/dashboard.test.js
if [[ "${1:-all}" != "unit" ]]; then
  node src/cli.js store-health --self-test
fi
