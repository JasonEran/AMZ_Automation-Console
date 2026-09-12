# AMZ Guard — 亚马逊店铺自动巡检

AMZ Guard 是面向运营与运维团队的单主机巡检系统：紫鸟负责店铺身份、指纹、Cookie 与登录流程，Selenium 只接管紫鸟 `startBrowser` 返回的浏览器；采集结果写入 JSON、CSV、HTML、历史状态和受登录保护的看板，并可独立投递钉钉与 CRM。

生产拓扑、部署步骤和日常值守分别见：

- [DEPLOY.md](DEPLOY.md)：Ubuntu `/opt/amzguard` 首次部署与发布验收
- [docs/OPERATIONS.md](docs/OPERATIONS.md)：服务、定时器、日志、补跑、备份和恢复
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)：按故障类型定位
- [docs/SECURITY.md](docs/SECURITY.md)：只读边界、凭据和安全事件处置
- [docs/INTELLIGENCE_V1.md](docs/INTELLIGENCE_V1.md)：独立竞品情报、单店主销与对标、采样口径和限制
- [docs/CHANGELOG.md](docs/CHANGELOG.md)：版本记录与验证结果
- [docs/GITHUB.md](docs/GITHUB.md)：源码同步、提交范围与发布版本管理

## 不可突破的边界

1. Seller Central、Amazon Ads 和 Amazon 商品页只能在对应店铺的紫鸟浏览器中访问。禁止普通 Chrome、独立 Playwright/Puppeteer、`curl` 等绕过紫鸟访问 Amazon。
2. 九项巡检及广告、Outlet Deal、VOC、Inbox 等 Amazon 操作严格只读。唯一例外是“商品批量上传”：已授权用户在 Dashboard 对已预检文件完成密码再认证、店铺/摘要核对和精确短语确认后，独立工作者才可通过对应店铺紫鸟访问固定批量上传页。它不能代替其他 Save、Submit、Create、Delete、Enable 或 Pause 操作，结果未知时绝不自动重试。
3. 程序不索取、读取、输出或保存 Amazon 密码和验证码。紫鸟负责填充；程序只判断验证码输入框是否已具备可提交形态，并点击已批准的登录流程。
4. 紫鸟、钉钉、CRM、Dashboard 和接收接口凭据只能进入 macOS Keychain、进程环境或服务器 `/etc/amzguard/*.env` 的最小权限 EnvironmentFile（均为 `root:root 0600`）。不同服务不得共享全量凭据；配置、日志、报告、截图、示例和 Git 中都不能出现真实值。
5. 无法判定不是正常。第 1 项只有 Policy Compliance 明确为 `Healthy` 才正常；第 2～9 项只有 DOM 与页面文本两路独立证据一致支持时才可输出正常。`UNKNOWN`、`ERROR`、`LOGIN_REQUIRED`、`PARTIAL_EVIDENCE` 与冲突都会告警。

## 九项检查

| # | 检查项 | 核心规则 | 北京时间 |
|---|---|---|---|
| 1 | 店铺健康 | Policy Compliance 仅 `Healthy` 正常；记录 AHR，并提示下降 | 08:00、15:30 |
| 2 | 账户绩效 | 识别红色告警、违规、限制、停用风险；零计数不误报 | 08:00、15:30 |
| 3 | Recent Feedback | 仅检查北京时间当天；当天低于 4 分即提醒，历史日期不跨天报警 | 08:00、15:30 |
| 9 | Inbox 买家消息 | 只读收件箱列表；出现未读/待回复即交运营，绝不打开会话（打开等于标记已读） | 08:00、15:30 |
| 4 | Customer Reviews | 全页采集 1～3 星评价并核对本店 ASIN 归属；首次发现提醒、重复归档；按发表日期倒序并关联逐页截图 | 08:00、15:30 |
| 5 | ASIN 常规 | 先用双路证据确认激活/可售状态；不存在或不可售则移出活跃数并跳过购物车、评分异常判断 | 08:00、15:30 |
| 6 | Outlet Deal | 用稳定标识做集合差，只提醒新增活动，绝不创建 Deal | 08:00、15:30 |
| 7 | Voice of the Customer | 逐 ASIN 只读详情，采集退货原因、客户问题、NCX、CX Health；本地/CRM 幂等登记 | 08:00、15:30 |
| 8 | 广告开关 | 先按每店可编辑的广告名称特征限定范围；11:20 多数应关闭，18:30 多数应开启；每店超过 50% 符合即正常，少数例外留档，多数不符告警，各半关注；绝不切换状态 | 11:20、18:30 |

表格按看板「客户声音」的阅读顺序排列（Feedback → Inbox → Reviews）；编号是历史标识，不随展示顺序重排。第 9 项只统计未读/待回复数量，不采集买家姓名、主题和消息正文，也不向 CRM 推送消息记录；页面没有暴露可判定的未读状态、或未能确认列表已无下一页时，按「采集待修复」提示，不判定正常。

商品真实异常、页面采集失败、尚未运行和未配置在报告与看板中是不同状态。单个 ASIN 超时不会中断同店其他 ASIN；渲染器超时会重开该店紫鸟浏览器，并将该 ASIN 在队尾重试一次。

## 受控商品批量上传

Dashboard 的“上传中心”工作区是唯一 Amazon 写入口，目标严格固定为 `https://sellercentral.amazon.com/product-search/bulk`。任务依次经过本地格式/ZIP 安全预检、私有暂存、安全扫描、Dashboard 密码再认证、店铺与 SHA-256 绑定确认，再由独立 systemd 工作者使用对应店铺的紫鸟会话提交。文件选择可能立即触发上传，因此工作者会在选择文件前持久化提交边界；边界后的中断或无法确认一律显示“结果未知”，不重试。用户管理工作区可由管理员创建、停用、删除账户、调整角色和重置密码；每个登录用户也可修改自己的密码，改密或角色变更会使旧会话失效。

该能力使用两个同时为 `1` 才生效的执行闸，生产模板默认均为 `0`。默认关闭是中性策略状态，不影响九项巡检。开启前必须完成 ClamAV 与新鲜签名校验、精确页面真机校准，并设置与 Dashboard 登录名完全一致的上传管理员；每一个真实文件仍需在 Dashboard 单独确认。

看板不再用一个笼统的“红/黄/错误”让老板猜责任人，而是在不改变底层严格判定的前提下分成四个行动口径：`正常`（无需处理）、`业务待处理`（运营）、`采集待修复`（技术）和`未完成`（排程）。原始 `OK/WARN/CRITICAL/ERROR`、状态码、双路证据与截图仍可在详情中核验；数据过期按采集待修复显示，不能继续保持绿色。

### ASIN 监测生命周期

`config/asins.json` 可为手工或 VOC 自动发现的 ASIN 设置监测策略：

```json
{
  "asin": "B012345678",
  "market": "US",
  "storeKey": "US-01",
  "monitoring": "weekly",
  "monitoringReason": "零售页长期无商品内容，VOC 仍可读取，保留周期复核"
}
```

- `active`：每个 ASIN 批次都检查（默认）。
- `weekly`：默认每 7 天复核一次；仍显示上次严格状态、原因和下次复核时间，VOC 不受影响。
- `disabled`：仅在运营已确认不再属于范围后人工停检，必须写原因。

一次超时、登录失败、`UNKNOWN`、空壳或单路证据都不能自动停检。只有可靠的商品证据或运营确认才能调整策略；已停检规则会覆盖后续 VOC 自动发现，避免商品被静默重新加入。

## 紫鸟官方 WebDriver 流程

项目默认 `ziniao.mode=webdriver`，遵循官方顺序：

```text
完全退出普通紫鸟进程
  → --run_type=web_driver --ipc_type=http --port=18888
  → updateCore（轮询成功）
  → getBrowserList
  → startBrowser（privacyMode=false、cookieTypeLoad=0）
  → Selenium 连接 debuggingPort
  → 打开 launcherPage 恢复平台会话
  → 必要时选择已有 Amazon 账户、Passkey、接受验证码并等待紫鸟填充
  → DOM + 页面文本双路只读采集
  → driver.quit → stopBrowser
```

业务 WebDriver HTTP 超时不低于 120 秒。旧 `ziniao-cli`/ZClaw 只保留为兼容后备，不是生产默认路径。

依据：[紫鸟 WebDriver 指南](https://open.ziniao.com/docSupport?docId=98)、[权限开通](https://open.ziniao.com/docSupport?docId=99)、[自动化 FAQ](https://open.ziniao.com/docSupport?docId=257)、[官方示例仓库](https://github.com/ziniao-open/ziniao_webdriver_demo)。

## 本地开发基线

要求 Node.js 22 或更高。先完整退出普通模式紫鸟，再执行：

```bash
git clone https://github.com/JasonEran/AMZ_Automation-Console.git
cd AMZ_Automation-Console
npm ci
test -e config/config.json || cp config/config.example.json config/config.json
test -e config/stores.json || cp config/stores.example.json config/stores.json
test -e config/asins.json || cp config/asins.example.json config/asins.json
npm test
node src/cli.js store-health --self-test
npm run doctor
```

前三条复制命令只在文件缺失时创建，不覆盖已有配置。`npm test` 和 `--self-test` 都是离线回归，不会启动紫鸟或访问 Amazon。测试数量会随解析规则增长，以命令最终显示的通过数为准。

### macOS 凭据

紫鸟与钉钉凭据可通过隐藏输入写入当前用户的登录 Keychain：

```bash
npm run credentials:setup
node scripts/configure-credentials.mjs setup dingtalk regular
node scripts/configure-credentials.mjs setup dingtalk operations
node scripts/configure-credentials.mjs status all
```

如果旧的、已被 Git 忽略的 `config/config.json` 曾含内联凭据，先审计再原子迁移；命令不会显示字段值：

```bash
node scripts/migrate-config-secrets.mjs
node scripts/migrate-config-secrets.mjs --apply
```

非 macOS 主机使用受保护的 EnvironmentFile。程序会拒绝加载含内联凭据的 JSON 配置。

### 店铺校准与真机检查

```bash
npm run stores
node src/cli.js run-check store-health --store US-01 --no-close --log-level debug
node src/cli.js run-check performance --store US-01 --no-close --log-level debug
```

`config/stores.json` 中应使用稳定、无敏感含义的 `key`，并填写紫鸟返回的店铺名称或 ID。首次校准检查 `out/` 下报告、脱敏文本和截图；不得因选择器变化而降低正常判定标准。

常用命令：

```bash
node src/cli.js checks
npm run am
npm run ads:off
npm run pm
npm run ads:on
node src/cli.js run-check reviews --store US-01
node src/cli.js run-check inbox --store US-01
node src/cli.js run-check asin-health --store US-01
```

退出码：`0` 全部正常，`1` 存在真实业务异常，`2` 为环境、配置或采集执行失败。定时任务将 `0/1` 都视为进程正常结束，但业务异常仍进入报告和告警；`2` 才是服务执行失败。

## 报告、状态与通道

```text
out/
  <check>/latest.json    该检查的最新批次入口
  <check>/YYYY-MM-DD/    JSON、CSV、HTML 与本批证据
    shots/               只读取证截图
    raw/                 已脱敏页面文本
  state/                 AHR、评分、Outlet 等跨次业务基线
  state/intelligence/    独立情报档案、队列、事件、经营参数和复核
  intelligence/          情报采样、事件归档与固定区间的选品销量快照
  alerts/                告警及投递结果审计
  channels/crm/          CRM 尝试、去重和结果审计
  channels/crm-export/   CRM 只读兼容 CSV、manifest 与生成审计
  runtime/               运行锁、实时进度与采集器健康
  logs/                  应用日志
```

报告 URL 在落盘前移除 query 与 fragment，API 不返回服务器绝对路径。历史数据可先 dry-run 再脱敏，脚本会原子替换并保留原修改时间：

```bash
node scripts/sanitize-history.mjs
node scripts/sanitize-history.mjs --apply
```

CRM 使用稳定幂等键、成功账本与相同的重试键；通道失败不会阻止主报告落盘。未取得正式 HTTPS 导入契约前，只生成 [CRM 兼容交换文件](docs/CRM_EXPORT_COMPATIBILITY.md)，不会向参考 CRM 写入。`npm run test-notify` 会向已启用的通知通道发送明确标注的“测试消息”，而 CRM 只做结构与幂等 dry-run，不会创建虚假业务记录。

## 看板

本地默认监听 `127.0.0.1:4173`：

```bash
npm run serve
```

生产环境由 systemd 守护，Node 仍只监听回环地址，Nginx 在 `https://amzcheck.pc51.com` 提供 HTTPS、登录限流与安全响应头。非回环或 `NODE_ENV=production` 时，缺少至少一个 Dashboard 用户、足够长度的 Session Secret 或独立 ingest token都会直接拒绝启动。看板按“每个店铺 × 每个检查项的最新有效报告”合并，单店补跑不会覆盖其他店铺结果；界面拆分为巡检总览、店铺风险、客户声音、商品状态、竞品情报、广告值守、上传中心、系统保障、用户管理九个工作区，各长列表独立分页。广告值守页的每店名称特征保存到私有运行时规则文件，下次巡检在打开状态筛选前先应用并精确复核；缺少规则时会在打开店铺浏览器前失败关闭。商品状态页展示动态活跃/非在售数量，但绝不自动修改商品；系统保障页显示 DOM 与页面文本双路证据完整率。紫鸟会话中心只展示登录/采集健康和建议动作，不读取密码、验证码或 Cookie。

生产部署不要使用旧 Windows 脚本；按 [DEPLOY.md](DEPLOY.md) 的 Linux 单主机流程执行。

## 独立竞品情报

从看板侧栏“竞品情报”进入 `/#intelligence`，旧 `/intelligence` 地址自动跳转。首次进入初始化一次，切入切出保留搜索、筛选及标签状态，左侧九个入口始终一致。可见且未打开对话框时每 15 秒刷新平台数据；这不等于重新访问 Amazon。

第一版独立建档、经紫鸟只读采集报价/可购买状态、保存前后证据并关联自有巡检；库存与成本费用在本平台手工维护，不依赖 CRM。单店“主销与对标”分开展示固定区间的本店销量与竞品公开购买量提示，后者仅用于观察样本的热度排序。支持手动队列和每 12 小时监测；新安装默认空名单、周期采集关闭，既有部署保留自己的试点名单与设置。使用与部署说明见 [独立竞品情报第一版](docs/INTELLIGENCE_V1.md)。
