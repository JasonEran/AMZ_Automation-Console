# 生产运维手册

适用环境：`123.58.218.45`、`/opt/amzguard`、Ubuntu 24.04、`Asia/Shanghai`。这里列出仓库模板的目标状态；实际部署版本与运行健康须通过主机验收确认。本文命令默认从服务器上的运维账户执行；涉及 systemd、Nginx、证书或权限时使用 `sudo`。

## 服务清单

| 单元 | 作用 | 启动方式 |
|---|---|---|
| `amzguard-xvfb.service` | 紫鸟专用虚拟显示 `:99` | enabled，开机自启 |
| `amzguard-ziniao.service` | 官方 WebDriver HTTP 模式紫鸟客户端 | enabled，自动重启 |
| `amzguard-dashboard.service` | 仅监听 `127.0.0.1:4173` 的登录看板 | enabled，自动重启 |
| `amzguard-store-health-am.timer` | 第 1～7 项与第 9 项 | 每日 08:00 |
| `amzguard-store-health-ads-off.timer` | 第 8 项，范围内超过 50% 应关闭 | 每日 11:20 |
| `amzguard-store-health-pm.timer` | 第 1～7 项与第 9 项 | 每日 15:30 |
| `amzguard-store-health-ads-on.timer` | 第 8 项，范围内超过 50% 应开启 | 每日 18:30 |
| `amzguard-collector-health.timer` | 紫鸟授权、核心与配置健康 | 启动后 2 分钟，每 10 分钟 |
| `amzguard-intelligence.timer` | 独立情报队列；单商品周期采样至少间隔 12 小时，手动队列另行处理 | 每 5 分钟检查队列 |
| `amzguard-intelligence.service` | 每次最多只读采集一个商品，与巡检共用运行锁 | 由 timer 触发，不常驻 |
| `amzguard-retention.timer` | 证据保留与权限修正 | 每日 03:10，带随机延迟 |
| `amzguard-cert-renew.timer` | IP TLS 证书续期检查 | 每日两次，带随机延迟 |
| `amzguard-product-upload.path` | 发现已确认上传任务 | 双闸开启时 enabled/active；默认关闭 |
| `amzguard-product-upload.timer` | 每分钟检查上传队列及待采集的批次结果 | 双闸开启时 enabled/active；默认关闭 |
| `amzguard-product-upload.service` | 优先执行已授权上传；队列为空时读取一个批次结果 | 由 path/timer 触发，不常驻 |
| `amzguard-manual@.service` | 单店/单项或单店/批次补跑 | 手动，不启用 |
| `amzguard-channel-test.service` | 明确标记的通知测试；CRM 仅 dry-run | 手动，不启用 |

## 每日值守

### 1. 总体状态

先按 Dashboard 的工作区查看：巡检总览、店铺风险、客户声音、商品状态、竞品情报、广告值守、上传中心、系统保障、用户管理和店铺配置。巡检业务页提供各自的店铺筛选、分页和行动队列；竞品情报的商品、变化、单店对标和人工复核按其独立范围展示；系统保障页集中展示实时进度、紫鸟会话、双路证据、告警历史和通道状态。再检查系统层：

```bash
sudo sh /opt/amzguard/deploy/verify-linux.sh
systemctl is-active amzguard-xvfb.service amzguard-ziniao.service amzguard-dashboard.service nginx.service
systemctl list-units --state=failed
systemctl list-timers --all 'amzguard-*.timer'
df -h /opt/amzguard
du -sh /opt/amzguard/out
```

`list-timers` 的 `NEXT` 是权威下一次执行时间。四个业务任务应分别为北京时间 08:00、11:20、15:30、18:30；不要根据上次结束时间猜测。

商品上传的授权、执行边界、接收回执、处理结果、报告下载及异常处置见[商品批量上传](../features/product-upload.md)。每日值守需同时核对双执行闸与 path/timer 的实际状态。

### 2. 最近一次任务结果

```bash
systemctl show amzguard-store-health-am.service \
  -p ActiveState -p Result -p ExecMainStatus \
  -p ExecMainStartTimestamp -p ExecMainExitTimestamp
journalctl -u amzguard-store-health-am.service -n 120 --no-pager -o short-iso
```

替换 unit 名检查其他时段。应用退出码含义：

- `0`：本批所有已运行项正常。
- `1`：发现业务异常。systemd unit 配置了 `SuccessExitStatus=0 1`，因此 service 的 `Result=success` 不表示业务全绿；以报告和 Dashboard 为准。
- `2`：`run-slot` / `run-check` 存在环境、配置、登录、采集或程序执行失败；systemd 应显示失败。旧 `store-health` 命令只有全部店铺均采集错误才返回 `2`，部分失败可能返回 `1`，仍须逐店查看报告。

### 3. 采集器健康

```bash
systemctl show amzguard-collector-health.service -p Result -p ExecMainStatus
journalctl -u amzguard-collector-health.service -n 80 --no-pager -o short-iso
```

健康结果还写入 `out/runtime/collector-health.json` 并进入 Dashboard。禁止通过输出环境变量来排查凭据；`doctor` 只应报告来源和完整性，不显示值。

## 状态口径

| 行动口径 | 原始状态 | 含义 | 责任人 / 动作 |
|---|---|---|---|
| 正常 | `OK` | 双路证据满足规则且数据未过期 | 无需处理 |
| 业务待处理 | `WARN`、`CRITICAL` | 评分下降、违规、当天低星、活跃商品无购物车、目标广告时段不符等 | 运营确认；自动化不修改 Amazon |
| 采集待修复 | `ERROR`、`NOT_CONFIGURED`，或数据过期 | 登录、页面、证据、解析、网络、渲染器、配置或程序失败 | 技术排障并针对性补跑 |
| 未完成 | `NEVER_RUN`、`NOT_COVERED`、`SKIPPED` 等 | 没有到期或可用结果，不是正常 | 检查排程、范围或跳过原因 |

若 DOM 与文本冲突，按更严重结果处理；`UNKNOWN`、`LOGIN_REQUIRED`、`PARTIAL_EVIDENCE` 绝不能手工改成正常。旧的有效基线不会被失败报告覆盖。

当前从非健康状态恢复为双路 `Healthy` 时，恢复记录进入历史 `notes`，当前单元显示正常；AHR 真实下降仍是业务关注。ASIN 的 `weekly` 低频复核和 `disabled` 人工停检在商品清单中独立展示，不计入正常数。调整 `config/asins.json` 前必须先核对真机证据；单次空壳或采集失败不构成停检依据。

Feedback 只按北京时间当天判断：当天有效的低于 4 分记录持续提醒，历史日期不跨天告警。仅排除页面明确标注由亚马逊承担物流责任的记录，并保留排除理由；两路排除数量不一致、未排除低分缺少可解析日期、两路日期范围未获证实或当天数量冲突时不能判为正常。Customer Reviews 和 VOC 的记录型事件使用稳定唯一键：首次出现时告警并写入历史；后续页面仍保留同一记录时显示“已提醒并归档”，不再重复占用当前待办。Reviews 以历史已见键去重，同一评价暂时消失后再次出现不会成为新差评；日期较早但首次发现的评价仍会提醒。VOC 的再次出现和 Poor 恶化为 Very Poor 按其事件规则重新判定。绩效违规不归档：Amazon 页面只要仍显示非零违规、限制或风险，就持续保留为业务待办，只有页面明确清除后才恢复正常。证据不完整时不更新去重基线，仍显示采集异常或原业务异常。

Inbox（第 9 项）只读取买家消息列表，绝不打开会话。未读或待回复消息持续提醒，交运营处理；只有完整双路证据确认清零才恢复正常。计数无法同时量化、未读状态不明或末页未确认时，保持采集待修复。结构化结果、列表证据和 CRM 摘要的边界见 [README 的第 9 项说明](../reference/checks.md#九项检查)。

广告默认按每店“广告名称包含”筛选广告组合，再完整读取命中组合的子活动；规则与有效状态分母见 [README 的广告口径](../reference/checks.md#广告范围与判定)。11:20 检查应关闭，18:30 检查应开启，不点击开关。管理员在广告值守页保存的规则位于 `out/runtime/ads-rules.json`（`0600`），下次巡检生效；范围缺失或证据不完整时保持采集待修复，不能改为全账户抽样。广告页的定期刷新只重读已有报告，不会重新采样 Amazon。

Amazon Ads 可能同时下发旧固定 ID 筛选器和新版 KAT/Shadow DOM 筛选器。自动化只接受活动表格外、同一弹层中唯一的 Enabled/Paused 成对单选项，且 Apply 必须与该单选组绑定。活动行的 switch 不会被视为筛选器。若新界面无法完成这些结构证明，必须保持 `PARTIAL_EVIDENCE`，不得根据按钮位置猜测点击。

`amzguard-collector-health.timer` 在业务巡检持有 `run.lock` 时会延后深度 `updateCore` 检查，保留上一次权威健康结果和本次 deferred 时间。这是避免授权健康探针与店铺 start/stop 并发，不是监控缺失。

## 店铺与页面配置

管理员在 `/#stores` 新增、编辑、启用或停用店铺。新增默认为停用，先核对紫鸟绑定和各检查的适用范围，再启用；保存本地配置不会访问 Amazon、启动任务、修改 CRM 或修改服务器 timer。新店是否进入下一次巡检取决于启用状态及实际排程；没有报告时显示未运行，不能视为正常。

| 字段 | 含义与限制 |
|---|---|
| `key` | 创建后不可修改的监测标识，1–64 位，字母数字开头，后续允许 `._-`；停用后仍占用该 key，避免历史串店 |
| `displayName` | 工作台与 CRM 店铺列表的展示名称；可独立修改，不影响紫鸟匹配 |
| `name` | 紫鸟中的精确店铺名称；未填 ID 时用于匹配，不能只当作显示名称 |
| `id` | 可空或数字 `browserId`，优先于名称；不填写 browserOauth、密码或其他凭据；历史不透明绑定只隐藏展示，未编辑时保留 |
| `market` / `host` | 从后端允许列表选择的站点代码和精确 Seller Central 域名；不接受任意 URL。允许配置不代表所有检查支持该地区，Reviews、广告及上传仍有各自的页面限制 |
| `enabled` | 是否参加后续监测；停用不删除报告。已有上传任务时不得借停用绕过确认或未知结果处理 |

新增店铺及已有绑定的编辑必须保留 `name/id` 至少一个；旧的无绑定停用占位记录可以保留，重新启用前必须补齐绑定。将现有 key 改绑为另一家实际店铺会混淆历史归属；新业务店铺应创建新 key。广告名称范围仍在“广告值守”维护，使用 `out/runtime/ads-rules.json`，店铺编辑器不建立第二套规则。CRM 店铺映射和授权名单独立维护，见 [CRM API](../integrations/crm-api.md#6-监测站配置)；新增店铺不会自动扩大机器令牌的授权。

初始店铺来自 `config/stores.json`。首次前端保存会将完整清单（含停用店铺）写入 `out/runtime/store-registry.json`，随后该文件是店铺配置的唯一来源；Dashboard、CRM 读 API 和之后启动的 CLI/工作者都使用它。修改 bootstrap 文件此时不生效。没有管理文件时才允许回退；管理文件损坏或权限异常会拒绝读取，不能通过删除文件或空白覆盖来“恢复默认”。保存文件权限为 `0600`，目录为 `0700`，包含版本和最后修改人/时间；备份时须保留。检查进程在取得运行锁后重读所选店铺的绑定并排除停用店；保留本次命令的明确店铺选择，不加入启动后新增的店铺。上传工作者在锁内读取完整启用清单后按任务 key 选择；已经开始的采样不会中途换店。

店铺绑定、启停及新增启用店铺的保存使用共享 `run.lock`，活动采集/上传期间返回 409。同店存在 `STAGED/QUEUED/PROCESSING/PREPARED/SUBMITTING/UNKNOWN` 上传记录，或账本不能完整核对时，拒绝改绑定或停用；展示名称仍可编辑。文件暂存提交前会再次检查绑定，避免大文件传输期间改店。管理文件另有独立保存锁及内容版本：两人同时编辑时，旧版本保存返回 409，前端保留草稿；先重载并比较，不能盲目重试。崩溃留下的 `store-registry.json.lock` / `ui-config.json.lock` 不会自动偷锁，须由运维核对无保存进程及目标文件完整性后处理。

同页“显示配置”管理以下参数，只改变网页读取已保存数据和分页的方式，不改变 Amazon 采样、业务阈值、权限或上传闸：

| 参数 | 默认 | 允许范围 |
|---|---|---|
| `reportRefreshSeconds` | 30 秒 | 5–300 秒 |
| `progressRefreshSeconds` | 2 秒 | 1–30 秒 |
| `uploadRefreshSeconds` | 15 秒 | 5–120 秒 |
| `matrixPageSize` | 8 条 | 1–100 条 |
| `listPageSize` | 10 条 | 1–100 条；上传任务受原接口 50 条上限约束 |
| `defaultView` | `overview` | 实际工作区 ID；普通用户不会默认进入管理员页 |

初值可写入 `config/config.json` 的 `dashboard` 对象（参见示例配置），修改初值后需重启 Dashboard；首次前端保存后以 `out/runtime/ui-config.json` 为准。配置不保存到浏览器 localStorage，切换工作区保留当前页的未保存草稿。竞品情报有独立刷新机制，CRM 的分页上限仍由其接口契约约束。

以下为监测站前端使用的管理接口，不能使用 CRM Bearer 或只读 Cookie 调用，不属于 CRM 取数契约：

| 方法与路径 | 请求 / 返回 |
|---|---|
| `GET /api/admin/stores` | 管理员读取 `{revision, contentSHA, source, stores, options, csrfToken, canManage}`；`source` 为 `bootstrap/managed/missing` |
| `POST /api/admin/stores` | `{expectedRevision, store}`，成功 201；`store` 使用上表字段 |
| `PATCH /api/admin/stores/{key}` | `{expectedRevision, patch}`，只提交已改字段，不能改 key；成功 200 |
| `GET /api/ui-config` | 已登录 Dashboard 用户读取 `{revision, source, settings, csrfToken, canManage}` |
| `PUT /api/admin/ui-config` | 管理员提交 `{expectedRevision, settings}`，settings 包含全部六项；成功 200 |
| `POST /api/admin/ziniao/restart` | 管理员提交空对象 `{}`。只执行 `systemctl restart amzguard-ziniao.service`。采集进程持有 `run.lock`，或采集单元为 active/activating 时返回 409 并不重启。本机没有该单元或 systemd 不可用时返回错误，不视为成功 |

写请求使用同源 `application/json` 和 Dashboard 会话，并将 GET 返回的 `csrfToken` 放入 `x-amzguard-csrf` 请求头；正文最多 32 KiB，不接受 query 或未知字段。成功写入返回最新完整上下文；错误为 `{ok:false,error,code?}`（既有登录/CSRF错误可能没有 code）。401 重新登录，403 核对管理员身份/CSRF，409 核对配置版本、活动任务或上传保护，400/415 修正字段或类型，503 检查损坏配置或权限。无删除店铺接口；历史报告不会被这些接口改写。凭据、任意 Amazon 路径、实际采集排程、CRM 网络推送和上传双闸仍由各自受保护配置管理。

店铺配置页的“重启紫鸟”使用上表重启接口，确认后才会请求。它不接受单元名称，也不会重启 Xvfb、看板或 Nginx。生产机上该操作依赖 `deploy/polkit/50-amzguard-ziniao-restart.rules`：只允许 `ubuntu` 对 `amzguard-ziniao.service` 执行 `restart`。部署脚本会安装这条规则；未安装时接口返回明确失败，而不是显示已重启。

## 手动补跑

手动任务只接收 `collector.env` 与 `channels.env`、同一 Xvfb 和紫鸟服务，不会获得 Dashboard 登录/Session/ingest 凭据；不需要也不允许把任何值复制进终端。格式是：

```text
amzguard-manual@<action>:<store-key>.service
```

`store-key` 必须取自当前有效店铺清单（管理页；未启用管理文件时为 `config/stores.json`），为 1–64 位、以字母或数字开头，仅含字母、数字、点、下划线或连字符。

单项补跑示例：

```bash
sudo systemctl start --no-block 'amzguard-manual@reviews:US-01.service'
journalctl -fu 'amzguard-manual@reviews:US-01.service'
```

可用检查项：`store-health`、`performance`、`feedback`、`inbox`、`reviews`、`asin-health`、`outlet`、`voc`。广告单项使用带明确期望的 `ads-status-off` 或 `ads-status-on`；此手动入口不接受 adhoc 广告判定。定向商品可使用 `asin-health-<ASIN>:<store-key>`（ASIN 为 `B0` 开头的 10 位大写字母/数字）；`product-upload-probe:<store-key>` 仅检查固定上传页控件，不选择文件或提交。

Reviews 补跑后核对分页覆盖、评价发表日期与对应页证据，具体上限和历史截图限制见 [README 的 Reviews 说明](../reference/checks.md#九项检查)。截图缺失或页身份变化的排查见 [Reviews 截图与日期](troubleshooting.md#reviews-截图显示旧评价或日期不一致)。

单店整批补跑：

```bash
sudo systemctl start --no-block 'amzguard-manual@am:US-01.service'
journalctl -fu 'amzguard-manual@am:US-01.service'
```

可用批次：`am`、`pm`、`ads-off`、`ads-on`。广告补跑必须选择与当前业务意图一致的时段；程序只检查，不会切换开关。

补跑前检查：

```bash
systemctl list-units --type=service 'amzguard-*'
```

程序有全局运行锁；已有巡检时新任务应以采集失败退出，而不是同时打开同一紫鸟环境。不要删除新鲜的 `out/runtime/run.lock` 来强行并发。合法锁记录的 PID 已不存在时，程序可直接改名恢复，不要求额外等待；损坏记录目前不能依赖自动过期，按 [运行锁与中断恢复](troubleshooting.md#9-运行锁与中断恢复) 人工核验。

## 日志与证据

### journald

```bash
journalctl -u amzguard-ziniao.service -n 120 --no-pager -o short-iso
journalctl -u amzguard-dashboard.service -n 120 --no-pager -o short-iso
journalctl -u amzguard-store-health-pm.service --since today --no-pager -o short-iso
journalctl -f -u amzguard-ziniao.service
```

### 文件

| 路径 | 内容 |
|---|---|
| `out/logs/` | 应用日志 |
| `out/<check>/latest.json` | 该检查的最新批次入口 |
| `out/<check>/YYYY-MM-DD/` | JSON、CSV、HTML 和本批报告 |
| `out/<check>/YYYY-MM-DD/shots/` | 页面证据 |
| `out/<check>/YYYY-MM-DD/raw/` | 已脱敏页面文本 |
| `out/alerts/*.jsonl` | 告警及各通道投递结果 |
| `out/channels/crm/` | CRM dry-run、尝试、去重和成功账本 |
| `out/channels/crm-export/` | 本地 CRM 兼容 CSV、manifest 与生成审计；不代表外部写入成功 |
| `out/runtime/run-progress.json` | 当前运行进度 |
| `out/state/intelligence/state.json` | 独立情报档案、队列、经营参数与复核 |
| `out/intelligence/` | 情报采样、事件归档与选品销量快照；不能加入 Git |
| `/var/log/nginx/amzguard.access.log` | 仅记录 `$uri`、不含 query 的访问审计 |
| `/var/log/nginx/amzguard.error.log` | 仅 `crit` 级 Nginx 传输/进程故障；不用于上游健康监控 |

上游可用性以 systemd 状态、journald 和 collector-health 为准。优先从 Dashboard 查看证据；它会过滤绝对服务器路径和 URL 私密部分。排障时不要把原始报告全文粘贴到工单或聊天。

查看文件权限而不输出内容：

```bash
find /opt/amzguard/out -xdev -type d ! -perm 0700 -printf '%m %p\n'
find /opt/amzguard/out -xdev -path '*/.evidence-quarantine' -prune -o -type f ! -perm 0600 -printf '%m %p\n'
```

## 钉钉与 CRM

通知故障与主报告独立：即使外部通道失败，报告必须先落盘，Dashboard 中会显示通道失败。

经维护负责人确认后执行测试：

```bash
sudo systemctl start amzguard-channel-test.service
systemctl show amzguard-channel-test.service -p Result -p ExecMainStatus
journalctl -u amzguard-channel-test.service -n 80 --no-pager -o short-iso
```

该服务会向已配置通知通道发送明确标注“测试消息，请忽略”的内容。CRM 只验证配置、结构、待发送数量和幂等键，不发网络写请求，也不创建测试记录。

CRM 正式导入使用：

- 记录级稳定 `idempotencyKey`。
- 批次重试复用相同 `Idempotency-Key`。
- 成功后写入 `out/channels/crm/ledger.json`，相同内容不重复发送。
- 每次尝试写 JSONL 审计，但不保存响应正文、Authorization 或含 query 的 endpoint。

CRM 账本损坏时系统会拒绝发送，防止重复创建。先备份损坏账本并修复，禁止直接清空后重跑历史批次。

在正式 HTTPS 导入契约确认前，Dashboard 的“CRM 兼容导出”只表示本地交换文件生成成功；“CRM”通道仍应显示未配置。两者不得合并成一个绿色状态。字段与启用门槛见 [CRM 只读兼容与导出约定](../integrations/crm-export.md)。

## 紫鸟会话故障

Dashboard“系统保障”页的“紫鸟会话中心”会把登录流程受阻与普通页面采集异常分开。若 Passkey 后停在 Amazon MFA：

1. 先定向补跑该店 `store-health`，确认日志是否出现“已请求紫鸟接收 Amazon 验证码”。
2. 若按钮从未出现，检查紫鸟自动验证码权限与自动填充黑名单；不要读取或人工记录验证码。
3. 若按钮已点击但紫鸟未完成填入/提交，保留 `LOGIN_REQUIRED`，由紫鸟管理员修复会话后再补跑。
4. 登录恢复成功后，再补跑该店其他采集失败项；不得手工把旧错误改绿。

紫鸟官方参考：[自动二次验证配置](https://help.ziniao.com/docs/verification/6flvSG28bgT_xjwq_zHHo)、[自动填充黑名单](https://help.ziniao.com/docs/verification/17363304369030)。

## 保留策略与容量

默认策略按文件 mtime 计算：页面证据 45 天、报告 365 天、应用日志 60 天、`alerts/`、`channels/` 与上传审计 365 天，上传 payload 7 天；Nginx 日志沿用 Ubuntu 的系统轮转策略。合法上传任务目录中的 `record.json` 与 `reset.json` 长期保留，维护原任务与人工重置的关联；清理原文件不会清除重复保护。`state/`、CRM 幂等账本 `channels/crm/ledger.json`、`runtime/` 下的 `ads-monitoring.json/ads-rules.json/users.json/store-registry.json/ui-config.json` 与各级 `latest.json` 不按期限删除。先 dry-run：

```bash
cd /opt/amzguard
sudo -u ubuntu /usr/local/bin/node src/tools/retention.js
```

当前权限修正仍会改变 `.evidence-quarantine/` 内应为 `000` 的隔离文件。存在隔离证据时，先停止 retention timer 并处理该代码问题，不执行 `--apply` 或启动清理服务。排除上述情形或修复后，确认候选数量和备份，才手动触发正式清理：

```bash
sudo systemctl start amzguard-retention.service
journalctl -u amzguard-retention.service -n 40 --no-pager
```

不要用宽泛的递归删除命令清理 `out/`。磁盘压力下可缩短证据保留期，但告警、CRM 审计、状态基线和最新报告不得作为临时文件删除。

## 备份与恢复

### 备份范围

- 代码与模板：`/opt/amzguard`，排除 `node_modules/` 和 `out/`。
- 运行数据：完整 `out/`，包含报告、状态、证据、CRM 账本和通道审计。
- 运行配置：`config/*.json` 以及 `out/runtime/store-registry.json`、`ui-config.json` 和广告配置；非秘密配置中不应有凭据。不要只恢复 bootstrap 店铺文件而遗漏当前管理清单。
- 凭据与策略：六个最小权限 EnvironmentFile 由外部密码管理系统或加密备份单独托管；不进入普通 tar、对象存储或工单，也不合并成全量文件。升级遗留的 `amzguard.env` 仅在回滚观察期内保持 root-only，确认新 unit 全部只引用拆分文件后按凭据销毁流程移除。
- 系统配置：`/etc/systemd/system/amzguard-*`、Nginx site、logrotate 配置和证书续期配置。

一致性要求较高时先按 [停止排程并备份](deployment.md#4-停止排程并备份) 停止 timer/path，并等待活动任务自然完成。恢复时先解压到隔离目录核对清单和权限，再恢复到目标；不要直接覆盖现有 `out/`。恢复 CRM 账本必须与对应报告一起进行，防止重复导入。

恢复后按顺序验证：离线测试、配置无内联凭据、systemd unit、Nginx、Dashboard 登录、collector-health、单店真机、通道状态、timer 下一次时间。

## TLS 证书

```bash
systemctl list-timers --all amzguard-cert-renew.timer
systemctl show amzguard-cert-renew.service -p Result -p ExecMainStatus
journalctl -u amzguard-cert-renew.service -n 80 --no-pager -o short-iso
sudo /opt/certbot-ip/bin/certbot certificates
```

告警条件：timer 未启用、最近执行失败、证书 SAN 不含生产 IP、有效期已过或距离到期不足下一轮可恢复窗口。续期成功后必须确认 Nginx reload 成功且公网实际呈现新证书。不要等到证书到期当天才处置。

## 服务器重启验收

仅在维护窗口、已有可用回滚和用户连接可恢复时重启。重启后检查：

1. Xvfb、紫鸟、Dashboard、Nginx 都为 active/enabled。
2. 必需巡检 timer 为 enabled/waiting 且 `NEXT` 时区正确；商品上传 path/timer 的状态必须与双闸一致，默认关闭时不得被误启用。
3. Dashboard HTTPS、登录保护、未认证 API `401` 正常。
4. collector-health 成功，紫鸟 WebDriver 授权与核心可用。
5. 没有因 `Persistent=true` 产生重叠补跑。
6. 最新每店/每项报告仍正确合并，CRM 账本和历史顺序未丢失。

故障处理见 [故障排查](troubleshooting.md)，安全事件见 [安全基线](security.md)。
