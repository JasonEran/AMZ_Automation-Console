#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: manual-run.sh <检查项或批次>:<store-key>" >&2
  exit 2
fi

spec=$1
action=${spec%%:*}
store_key=${spec#*:}

if [ "$action" = "$spec" ] || [ -z "$store_key" ]; then
  echo "必须同时指定检查项/批次和 store-key" >&2
  exit 2
fi

case "$store_key" in
  *[!A-Za-z0-9._-]*)
    echo "store-key 仅允许字母、数字、点、下划线和连字符" >&2
    exit 2
    ;;
esac

case "$action" in
  am|pm|ads-off|ads-on)
    exec /usr/local/bin/node /opt/amzguard/src/cli.js run-slot "$action" --store "$store_key"
    ;;
  store-health|performance|feedback|inbox|reviews|asin-health|outlet|voc)
    exec /usr/local/bin/node /opt/amzguard/src/cli.js run-check "$action" --store "$store_key"
    ;;
  asin-health-B0????????)
    target_asin=${action#asin-health-}
    case "$target_asin" in
      *[!A-Z0-9]*) echo "ASIN 仅允许大写字母和数字" >&2; exit 2 ;;
    esac
    exec /usr/local/bin/node /opt/amzguard/src/cli.js run-check asin-health --store "$store_key" --asin "$target_asin"
    ;;
  product-upload-probe)
    exec /usr/local/bin/node /opt/amzguard/src/cli.js product-upload-probe --store "$store_key"
    ;;
  ads-status-off)
    exec /usr/local/bin/node /opt/amzguard/src/cli.js run-check ads-status --store "$store_key" --slot ads-off
    ;;
  ads-status-on)
    exec /usr/local/bin/node /opt/amzguard/src/cli.js run-check ads-status --store "$store_key" --slot ads-on
    ;;
  *)
    echo "未知检查项或批次" >&2
    exit 2
    ;;
esac
