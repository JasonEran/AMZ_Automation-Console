# 生产运维手册

适用环境：`123.58.218.45`、`/opt/amzguard`、Ubuntu 24.04、`Asia/Shanghai`。本文命令默认从服务器上的运维账户执行；涉及 systemd、Nginx、证书或权限时使用 `sudo`。

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
| `amzguard-intelligence.timer` | 独立情报队列；单商品至少间隔 12 小时的周期采样 | 每 5 分钟检查队列 |
| `amzguard-intelligence.service` | 每次最多只读采集一个商品，与巡检共用运行锁 | 由 timer 触发，不常驻 |
| `amzguard-retention.timer` | 证据保留与权限修正 | 每日 03:10，带随机延迟 |
| `amzguard-cert-renew.timer` | IP TLS 证书续期检查 | 每日两次，带随机延迟 |
| `amzguard-product-upload.path` | 发现已确认上传任务 | 双闸开启时 enabled/active；默认关闭 |
| `amzguard-product-upload.timer` | 上传队列一分钟兜底 | 双闸开启时 enabled/active；默认关闭 |
| `amzguard-product-upload.service` | 独立安全扫描与对应紫鸟提交 | 由 path/timer 触发，不常驻 |
| `amzguard-manual@.service` | 单店/单项或单店/批次补跑 | 手动，不启用 |
| `amzguard-channel-test.service` | 明确标记的通知测试；CRM 仅 dry-run | 手动，不启用 |

## 每日值守

### 1. 总体状态

先按 Dashboard 的九个工作区查看：巡检总览、店铺风险、客户声音、商品状态、竞品情报、广告值守、上传中心、系统保障和用户管理。巡检业务页提供各自的店铺筛选、分页和行动队列；竞品情报的商品、变化、单店对标和人工复核按其独立范围展示；系统保障页集中展示实时进度、紫鸟会话、双路证据、告警历史和通道状态。再检查系统层：

```bash
sudo sh /opt/amzguard/deploy/verify-linux.sh
systemctl is-active amzguard-xvfb.service amzguard-ziniao.service amzguard-dashboard.service nginx.service
systemctl list-units --state=failed
systemctl list-timers --all 'amzguard-*.timer'
df -h /opt/amzguard
du -sh /opt/amzguard/out
```

`list-timers` 的 `NEXT` 是权威下一次执行时间。四个业务任务应分别为北京时间 08:00、11:20、15:30、18:30；不要根据上次结束时间猜测。

商品上传默认关闭，此时 path/timer 必须同时 disabled/inactive，Dashboard 显示“按策略关闭”而不是故障。只有双闸均为 `1` 时才要求 path/timer enabled/active；每个文件仍需在 Dashboard 完成独立确认。查看上传工作者时只读取状态和脱敏日志，不输出 EnvironmentFile：

```bash
systemctl is-enabled amzguard-product-upload.path amzguard-product-upload.timer
systemctl is-active amzguard-product-upload.path amzguard-product-upload.timer
systemctl show amzguard-product-upload.service -p ActiveState -p Result -p ExecMainStatus
journalctl -u amzguard-product-upload.service -n 80 --no-pager -o short-iso
```

`COMPLETED` 仅表示 Amazon 上传端明确接收文件，最终商品处理仍以 Seller Central 处理报告为准；`UNKNOWN` 表示越过提交边界后无法确认，禁止重启或手工补队列，必须由运营在对应店铺人工核对。

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
- `2`：环境、配置、登录、采集或程序执行失败；systemd 应显示失败。

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

Feedback 只按北京时间当天判断：当天存在低于 4 分的记录就保持提醒，历史日期不跨天告警；日期缺失或两路当天数量冲突时按采集异常处理，不能假绿。Customer Reviews 和 VOC 的记录型事件使用稳定唯一键：首次出现时告警并写入历史；后续页面仍保留同一记录时显示“已提醒并归档”，不再重复占用当前待办。Reviews 以历史已见键去重，同一评价暂时消失后再次出现不会成为新差评；日期较早但首次发现的评价仍会提醒。VOC 的再次出现和 Poor 恶化为 Very Poor 按其事件规则重新判定。绩效违规不归档：Amazon 页面只要仍显示非零违规、限制或风险，就持续保留为业务待办，只有页面明确清除后才恢复正常。证据不完整时不更新去重基线，仍显示采集异常或原业务异常。

Inbox（第 9 项）只读取买家消息列表：出现未读或页面标记为待回复的消息即为业务待处理，交运营在 24 小时内回复，未读清零后自动恢复正常，因此同一批未读会在每个批次持续提醒。系统绝不打开消息会话——打开等于把消息标记为已读，属于 Amazon 写操作。列表行只保留日期、未读/待回复标记和可见订单号，不采集买家姓名、主题和消息正文，也不推送 CRM。若页面未暴露可判定的未读状态、两路计数无法同时量化，或无法确认列表已无下一页，一律显示采集待修复，不得手工改成正常。

广告任务先读取 Dashboard 中每店独立的“广告名称包含”规则，并在状态筛选之前把该值写入唯一、语义明确的活动名称搜索框，再精确复核输入值。缺少规则、搜索框歧义或复核失败时在读取状态前停止，绝不回退成全账户检查。限定范围后，按广告组合及其活动的有效状态检查：11:20 应关闭，18:30 应开启，每店范围内超过 50% 符合才满足多数规则，少数例外留档；各半需要关注，多数不符告警。缺页、未知状态、双路冲突和投放受限仍单独处理，不能被多数比例掩盖。这要求目标范围的完整证据，不是抽样前几条；不点击任何广告开关。规则由管理员在广告值守页修改，保存到 `out/runtime/ads-rules.json`（`0600`），下次巡检生效。

Amazon Ads 可能同时下发旧固定 ID 筛选器和新版 KAT/Shadow DOM 筛选器。自动化只接受活动表格外、同一弹层中唯一的 Enabled/Paused 成对单选项，且 Apply 必须与该单选组绑定。活动行的 switch 不会被视为筛选器。若新界面无法完成这些结构证明，必须保持 `PARTIAL_EVIDENCE`，不得根据按钮位置猜测点击。

`amzguard-collector-health.timer` 在业务巡检持有 `run.lock` 时会延后深度 `updateCore` 检查，保留上一次权威健康结果和本次 deferred 时间。这是避免授权健康探针与店铺 start/stop 并发，不是监控缺失。

## 手动补跑

手动任务只接收 `collector.env` 与 `channels.env`、同一 Xvfb 和紫鸟服务，不会获得 Dashboard 登录/Session/ingest 凭据；不需要也不允许把任何值复制进终端。格式是：

```text
amzguard-manual@<action>:<store-key>.service
```

`store-key` 必须取自 `config/stores.json`，并只含字母、数字、点、下划线或连字符。

单项补跑示例：

```bash
sudo systemctl start --no-block 'amzguard-manual@reviews:US-01.service'
journalctl -fu 'amzguard-manual@reviews:US-01.service'
```

可用检查项：`store-health`、`performance`、`feedback`、`inbox`、`reviews`、`asin-health`、`outlet`、`voc`。广告单项必须使用带明确期望的 `ads-status-off` 或 `ads-status-on`；不接受含义不清的 adhoc 广告判定。

Review 采集会在每一页通过双路验证后立即保存截图，翻页前后绑定页码、评论 ID、发表日期范围和截图采集时间。默认截图指向本店最新发表评价所在页；明细和历史按发表日期从新到旧显示，每条评价可打开其所在页截图。截图前后评论行发生变化时拒绝关联该图片。无法解析的日期保留待核验，旧日期的新发现仍按原规则提醒。

旧报告只保留末页截图的，会明确标注页码与限制，不修改历史图片和发表日期。证据页中的采集时间统一显示北京时间；评论发表日期保持 Amazon 原始日期口径，两者不能混用。

单店整批补跑：

```bash
sudo systemctl start --no-block 'amzguard-manual@am:US-01.service'
journalctl -fu 'amzguard-manual@am:US-01.service'
```

可用批次：`am`、`pm`、`ads-off`、`ads-on`。广告补跑必须选择与当前业务意图一致的时段；程序只检查，不会切换开关。

补跑前检查：

```bash
systemctl list-units --type=service 'amzguard-store-health-*' 'amzguard-manual@*'
```

程序有全局运行锁；已有巡检时新任务应以采集失败退出，而不是同时打开同一紫鸟环境。不要删除新鲜的 `out/runtime/run.lock` 来强行并发。只有确认记录的 PID 已不存在且锁超过程序定义的失效期限时，才按排障文档处理。

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
find /opt/amzguard/out -xdev -type f ! -perm 0600 -printf '%m %p\n'
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

在正式 HTTPS 导入契约确认前，Dashboard 的“CRM 兼容导出”只表示本地交换文件生成成功；“CRM”通道仍应显示未配置。两者不得合并成一个绿色状态。字段与启用门槛见 [CRM 只读兼容与导出约定](CRM_EXPORT_COMPATIBILITY.md)。

## 紫鸟会话故障

Dashboard“系统保障”页的“紫鸟会话中心”会把登录流程受阻与普通页面采集异常分开。若 Passkey 后停在 Amazon MFA：

1. 先定向补跑该店 `store-health`，确认日志是否出现“已请求紫鸟接收 Amazon 验证码”。
2. 若按钮从未出现，检查紫鸟自动验证码权限与自动填充黑名单；不要读取或人工记录验证码。
3. 若按钮已点击但紫鸟未完成填入/提交，保留 `LOGIN_REQUIRED`，由紫鸟管理员修复会话后再补跑。
4. 登录恢复成功后，再补跑该店其他采集失败项；不得手工把旧错误改绿。

紫鸟官方参考：[自动二次验证配置](https://help.ziniao.com/docs/verification/6flvSG28bgT_xjwq_zHHo)、[自动填充黑名单](https://help.ziniao.com/docs/verification/17363304369030)。

## 保留策略与容量

默认策略：页面证据 45 天、报告 365 天、应用日志 60 天、`alerts/` 与 `channels/` 审计 365 天；Nginx 日志沿用 Ubuntu 的系统轮转策略。只有 `state/`、CRM 幂等账本 `channels/crm/ledger.json` 与各级 `latest.json` 长期保留。先 dry-run：

```bash
cd /opt/amzguard
sudo -u ubuntu /usr/local/bin/node src/tools/retention.js
```

确认候选数量和备份后，才手动触发正式清理：

```bash
sudo systemctl start amzguard-retention.service
journalctl -u amzguard-retention.service -n 40 --no-pager
```

不要用宽泛的递归删除命令清理 `out/`。磁盘压力下可缩短证据保留期，但告警、CRM 审计、状态基线和最新报告不得作为临时文件删除。

## 备份与恢复

### 备份范围

- 代码与模板：`/opt/amzguard`，排除 `node_modules/` 和 `out/`。
- 运行数据：完整 `out/`，包含报告、状态、证据、CRM 账本和通道审计。
- 运行配置：`config/*.json`，其中不应有凭据。
- 凭据与策略：六个最小权限 EnvironmentFile 由外部密码管理系统或加密备份单独托管；不进入普通 tar、对象存储或工单，也不合并成全量文件。升级遗留的 `amzguard.env` 仅在回滚观察期内保持 root-only，确认新 unit 全部只引用拆分文件后按凭据销毁流程移除。
- 系统配置：`/etc/systemd/system/amzguard-*`、Nginx site、logrotate 配置和证书续期配置。

一致性要求较高时先停止 timer，并等待活动采集自然完成。恢复时先解压到隔离目录核对清单和权限，再恢复到目标；不要直接覆盖现有 `out/`。恢复 CRM 账本必须与对应报告一起进行，防止重复导入。

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

故障处理见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)，安全事件见 [SECURITY.md](SECURITY.md)。
