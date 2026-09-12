#!/usr/bin/env bash
# 用 Codex 驱动本次店铺健康巡检。
#
# 分工：Amazon 只由紫鸟启动的店铺浏览器访问，Codex 不登录亚马逊后台；
# Codex 负责跑检查、读结果、判断要不要人工介入，并给出中文结论。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

SLOT="${1:-}"
SLOT_ARG=()
if [[ -n "$SLOT" ]]; then SLOT_ARG=(--slot "$SLOT"); fi

if ! command -v codex >/dev/null 2>&1; then
  echo "找不到 codex，直接执行确定性检查。" >&2
  exec node src/cli.js store-health "${SLOT_ARG[@]}"
fi

PROMPT=$(cat <<'EOF'
你在运维一套亚马逊店铺自动巡检系统（仓库根目录就是当前工作目录）。

请完成本次「第 1 项：店铺健康状态检查」：

1. 执行 `node src/cli.js store-health`（如果我给了 --slot 参数就带上）。
2. 读取它的退出码：0 = 全部正常，1 = 存在异常，2 = 环境/配置问题。
3. 打开它生成的 JSON 报表（路径在输出里，也可读 out/store-health/latest.json），
   逐店检查 status / severity / confidence / anomalyReasons / ahrDelta。
4. 用中文给出结论，包含：
   - 每个店铺的 Policy Compliance 状态（Healthy 之外一律算异常）
   - 需要人工立刻处理的店铺，以及建议的处理动作
   - confidence 为 conflict 或 low 的店铺，明确提示「判定不可靠，请人工看截图复核」
   - 如果退出码是 2，说明是环境问题而不是店铺问题，指出具体缺什么

约束：
- 不要自己去登录亚马逊后台，也不要直接调用浏览器；所有亚马逊访问都必须经由
  `node src/cli.js ...`（其内部默认走紫鸟官方 WebDriver + Selenium）。
- 不要修改仓库里的源码或配置文件，本次只做「执行 + 判读 + 汇报」。
- 如果报表显示解析置信度不足，不要替它下结论说「正常」。
EOF
)

if [[ -n "$SLOT" ]]; then
  PROMPT="$PROMPT

本次批次参数：--slot $SLOT"
fi

exec codex exec \
  --skip-git-repo-check \
  --color never \
  -s workspace-write \
  "$PROMPT"
