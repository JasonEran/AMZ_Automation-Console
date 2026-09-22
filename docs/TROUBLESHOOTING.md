# 故障排查手册

排障目标是把失败可靠归类并恢复采集，不是让看板变绿。任何 `UNKNOWN`、`ERROR`、`LOGIN_REQUIRED`、`PARTIAL_EVIDENCE`、双路冲突或双路失败都必须保留并告警，直到有真机证据证明原因。

## 固定排查顺序

```bash
cd /opt/amzguard
npm test
systemctl show amzguard-collector-health.service -p Result -p ExecMainStatus
journalctl -u amzguard-collector-health.service -n 100 --no-pager -o short-iso
systemctl list-units --type=service 'amzguard-*'
```

随后从 Dashboard 打开失败店铺、检查项、判定依据与截图，最后才做单店/单项补跑。不得使用普通浏览器、Playwright、Puppeteer 或 `curl` 访问 Amazon 来“对照”。

## 快速分类

| 类别 | 常见证据 | 责任边界 |
|---|---|---|
| 程序错误 | 退出码 2、未捕获异常、离线回归失败、没有正式错误报告 | 先修代码和测试 |
| 页面结构变化 | 页面已加载但 DOM/text 解析缺字段、两路冲突、截图中结构改变 | 基于真机证据更新解析器并加回归 |
| 登录/会话问题 | `LOGIN_REQUIRED`、账户选择页、Passkey/MFA 未完成、跳回登录 | 恢复紫鸟会话，不接触账号密码/OTP |
| 网络/渲染器问题 | 页面加载超时、WebDriver 断开、renderer crash、Robot Check | 重试/重启对应紫鸟店铺，保留为采集失败 |
| 配置问题 | `doctor` 缺键、店铺找不到、端口/路径错误、内联凭据被拒绝 | 修 EnvironmentFile 或非敏感配置 |
| 真实业务异常 | 双路证据支持违规、当天低星、活跃商品无购物车、目标广告时段不符等 | 运营处置；自动化保持 Amazon 只读 |
| 通道故障 | 报告已落盘，但钉钉/CRM 审计失败 | 修外部通道，不回滚主报告 |

## 1. 程序错误

症状：任务 `Result=failed`、`ExecMainStatus=2`，日志含堆栈，或某检查没有生成正式 `ERROR` 报告。

```bash
systemctl show amzguard-store-health-am.service \
  -p Result -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp
journalctl -u amzguard-store-health-am.service --since today --no-pager -o short-iso
```

处理：

1. 在本地用同一份脱敏证据复现，不在生产直接猜改。
2. 每个解析、判定或传输修复都增加离线断言。
3. 运行 `npm test`（已包含 `store-health --self-test`），记录本次实际结果。
4. 本地通过后按部署流程发布，再只补跑失败店铺/检查项。
5. 检查正式报告与 Dashboard 状态，不能仅凭 systemd `success` 验收。

若顶层任务异常但其他检查成功，应仍存在单独的错误报告和运维告警；缺少它本身就是程序缺陷。

## 2. 页面结构变化或解析冲突

症状：页面 URL 和标题合理、截图中有内容，但报告为 `UNKNOWN`、`PARTIAL_EVIDENCE`、字段缺失或 DOM/text 冲突。

检查：

- 确认截图不是空壳、骨架屏、登录页、验证码页、Robot Check 或 404。
- 对异步 Reviews/VOC 页面确认真实卡片或表格已经出现，而非仅导航栏文字。
- DOM 与页面文本分别记录了什么；冲突时以更严重结果为准。
- 中英文页面、灰度版本、market/账户切换是否改变结构。
- `Violations 0`、`0 results` 和筛选器文本是否被误当成异常实体。

修复原则：只依据真机 DOM、文本与截图更新选择器/规则；注入脚本保持纯 ASCII、ES5。新增真机样本的脱敏 fixture 与断言后再发布。禁止扩大“正常”正则、跳过缺字段或把单路证据当正常。

2026-09-05 真机确认的两类结构/时序问题：

- Ads 的 AG Grid 将同一活动拆成固定名称列和中央状态列，两部分共享 `row-id`。多个活动的状态、日期文本可能完全相同，必须按活动 ID 合并，不能按文本合并。`ag-Grid-SelectionColumn` 中的复选框只表示行选择，不表示广告暂停。仍需核对 DOM 活动数、文本活动数和表格尾部总数；缺行不能用页尾总数补成完整 DOM。
- Feedback 的片段地址、VOC 的规范化路径、ASIN 的 `th` 参数可能在首次渲染后变化。Feedback/VOC 以及 ASIN 的证据读取允许最多两次从零重试，覆盖安全探针期间、证据读取前及读取期间的地址变化。每次丢弃旧 DOM/文本，再重复全部实时校验；完整 URL（包括 query/fragment）在一次读取得到的证据中必须一致。持续变化、认证/拦截或目标 ASIN 不符继续报采集失败。

### Reviews 截图显示旧评价或日期不一致

先区分“评价发表日期”和“截图采集时间”：今天采集到较早发表的评价是允许的，不能把发表日期改成今天。查看本店最新发表日期、评价所在页、分页覆盖和采集完成时间，再核对逐页证据。

分页上限、逐页截图条件和历史报告限制见 [README 的 Reviews 说明](../README.md#九项检查)。翻新界面不会补出从未保存的图片；只有品牌最新评价但不属于本店时，不应替代本店最新评价。

若出现 `REVIEWS_EVIDENCE_PAGE_CHANGED` 或对应页图片缺失，检查采集日志和双路证据，按 [手动补跑](OPERATIONS.md#手动补跑) 对目标店铺只读复采。不要删历史、复制其他页截图或改日期来消除差异。

### 进入竞品情报后整页重载或侧栏缺少入口

当前入口为 `/#intelligence`；旧 `/intelligence` 登录后会跳转。直接访问旧地址产生一次跳转属于兼容行为，从主看板切换栏目应保持九个入口与已输入状态。先刷新一次主看板以加载已部署页面，再验证切换及浏览器前进/后退；若仍重载，核对 Dashboard 实际服务的源码和部署清单。情报栏目每 15 秒的 API 数据刷新与整页重载、至少相隔 12 小时、满足排程条件才执行的 Amazon 周期采样是不同动作。

## 3. 登录或会话问题

症状：`LOGIN_REQUIRED`、Seller Central/Ads 反复跳登录、账户选择失败、Passkey 原生框未确认、紫鸟未自动填验证码。

```bash
systemctl is-active amzguard-xvfb.service amzguard-ziniao.service
journalctl -u amzguard-ziniao.service -n 160 --no-pager -o short-iso
systemctl show amzguard-collector-health.service -p Result -p ExecMainStatus
```

检查：

1. 普通模式紫鸟是否已完全退出，WebDriver 模式是否由 systemd 唯一管理。
2. `DISPLAY=:99`、Xauthority、`xdotool` 和紫鸟客户端路径是否有效。
3. 自动化成员是否仍有店铺查看权限和 WebDriver 权限。
4. 官方顺序是否仍为 `updateCore → getBrowserList → startBrowser`，启动参数是否显式包含 `privacyMode=false`、`cookieTypeLoad=0`。
5. Ads 必须最终进入 `advertising.amazon.com`；Seller Central 菜单文字不算成功进入广告控制台。

允许的自动登录动作限定在对应店铺的已批准认证页：选择唯一已有账户、继续、点击紫鸟 Passkey；MFA 恰有三个可见可用方式时选择已批准的第一项并发送一次性密码，接受紫鸟验证码、等待填入并登录；账户切换页按目标市场选择已有账户。登录失败仍须保留失败状态。原生 Passkey/市场点击当前仅在 Linux 的 `xdotool` 路径实现。不得读取字段值，不得在日志/报告/截图中保存密码或验证码。认证页默认不落原文和截图；不要为了排障临时打开此取证。

若需要重启紫鸟，先按 [部署第 4 节](../DEPLOY.md#4-停止排程并备份) 暂停所有相关 timer/path，并确认巡检、手动、情报、上传和维护任务均已结束：

```bash
systemctl list-units --type=service 'amzguard-*'
sudo systemctl restart amzguard-xvfb.service
sudo systemctl restart amzguard-ziniao.service
sudo systemctl start amzguard-collector-health.service
```

这会关闭当前店铺浏览器，只能在没有运行任务时执行。店铺配置页的“重启紫鸟”只重启 `amzguard-ziniao.service`：采集进程持有 `out/runtime/run.lock`，或采集单元处于 active/activating 时会拒绝并说明原因。

## 4. 网络、WebDriver 或渲染器

症状：紫鸟 HTTP 超时、Selenium 断开、页面加载超时、`renderer`/`tab crashed`、Robot Check 或某个 ASIN 长时间卡住。

```bash
sudo ss -lntp | grep ':18888 '
journalctl -u amzguard-ziniao.service --since '-30 min' --no-pager -o short-iso
journalctl -u amzguard-collector-health.service --since '-30 min' --no-pager -o short-iso
```

本机 18888 健康探针允许请求紫鸟本地 API；禁止把任何 HTTP 工具指向 Amazon。正式 WebDriver HTTP 调用超时必须至少 120 秒。

第 5 项会把单 ASIN 超时与商品状态分开：先由 DOM 与页面文本两路确认 ASIN 是否激活/可售；两路均为 `Page Not Found` 或 `Currently unavailable` 时标记 `INACTIVE_LISTING`，移出活跃数并跳过购物车、评分异常判断。只有单路发现非在售时保持 `PARTIAL_EVIDENCE`，不能擅自排除。渲染器超时时重启该店紫鸟浏览器，并在队尾重试一次；重试仍失败应保持采集故障，不能伪造成商品状态。

若某 ASIN 跨批次持续没有零售页内容，先确认它是否仍存在于最新成功 VOC：仍在 VOC 的商品不是“根本不存在”，可在 `config/asins.json` 设为 `monitoring: weekly` 并填写证据日期和原因，降低零售页复核频率但继续采集 VOC。只有运营明确确认不再属于范围时才设为 `disabled`。这两类必须继续出现在 Dashboard 的 ASIN 监测清单中；不得通过删除历史报告或把 `UNKNOWN` 改绿来消除告警。

Robot Check 属于采集失败，不是商品业务异常。反复出现时检查紫鸟环境/IP、并发和访问节奏；不要绕过紫鸟或提高并发碰运气。

### 店铺级代理故障的识别与恢复

同一店铺同时在 Reviews、Ads 和多个 ASIN 出现 `ERR_CONNECTION_RESET`、`i/o timeout`、`AutoSelector EOF` 或紫鸟内部错误页，而其他店铺没有同类错误时，应优先归类为店铺专属代理/线路故障，不要改解析器或删除商品。

1. 确认无 `run.lock` 且无活动采集单元。
2. 保留失败报告、安全错误码和日志计数，不保存认证页原文/截图。
3. 在没有活动任务时可重启 `amzguard-ziniao.service` 刷新本地代理选择状态，然后只补跑该店失败项。
4. 重启后仍连续失败，必须在紫鸟后台修复/更换该店线路；不允许改成普通 Chrome 直连 Amazon。

Reviews 页面的中央加载圈、页码 `/0` 且 DOM/文本均无明确空态，只是未水合的 SPA 空壳，不是“0 条评论”。系统会拒绝保存这类截图并换新会话有界重试；重试耗尽仍保持采集故障。

第 5 项的队尾重试只有一次预算。恢复会话后应直接导航到精确 ASIN 并通过 URL、实时页面和 ASIN 身份三道门；不得对队列中间项留下的页面做“预热成功”假设。预算耗尽后不再重建店铺会话，避免打断后续 ASIN。

## 5. 配置问题

症状：任务启动前退出、`doctor` 报缺凭据/客户端/店铺，或报 `config.json 含禁止落盘的凭据字段`。

只核验键名和文件元数据：

```bash
sudo stat -c '%U:%G %a %n' /etc/amzguard/{dashboard,ziniao,collector,channels,retention,product-upload}.env
for env_file in /etc/amzguard/{dashboard,ziniao,collector,channels,retention,product-upload}.env; do
  sudo awk -F= '/^[A-Z][A-Z0-9_]*=/{print FILENAME ":" $1}' "$env_file"
done
stat -c '%U:%G %a %n' /opt/amzguard/config/*.json
```

不要运行 `env`、`systemctl show-environment` 或带值的 `grep`。六个最小权限 EnvironmentFile 应为 `root:root 0600`；`product-upload.env` 只能包含双闸、上传管理员和扫描策略，不得放 Dashboard/紫鸟/通道凭据。`config/` 应为 `root:ubuntu 0750`，三个运行配置必须为 `ubuntu:ubuntu 0600` 且无凭据。Dashboard 生产模式必须有至少一个可用用户、至少 32 字符的 Session Secret 和独立 ingest token，否则应拒绝启动；初始化与用户库要求见 [安全说明](SECURITY.md#凭据存放)。

macOS 旧配置迁移：

```bash
node scripts/migrate-config-secrets.mjs
node scripts/migrate-config-secrets.mjs --apply
node scripts/configure-credentials.mjs status all
```

Linux 不使用该 Keychain 迁移。若服务器仍只有旧 `/etc/amzguard/amzguard.env` 且六个目标文件尚不存在，使用 `sudo sh /opt/amzguard/deploy/migrate-env-layout.sh` 做不回显值的 allow-list 拆分；目标已存在时脚本会拒绝覆盖，应改用 `sudoedit` 逐项修复。旧文件只作短期回滚，任何新 unit 都不能再引用它。

### 商品上传状态异常

- “按策略关闭”：不是故障。确认 `product-upload.env` 双闸为默认 `0/0`，path/timer 应 disabled/inactive，九项巡检继续运行。
- “提交前失败”：Amazon 尚未越过提交边界。核对 ClamAV 可执行文件、`/var/lib/clamav` 签名新鲜度、店铺是否启用、紫鸟会话和固定页面控件；修复后必须由用户重新暂存并确认，不能手工改账本。
- “Amazon 已拒绝”：业务文件错误，由运营修正模板后新建任务；不要归类为采集故障。
- “结果未知”：表示文件选择/提交边界后中断或无法绑定本次新增结果。绝不重跑 service、复制 queue marker 或重新上传同一文件；应通过对应店铺紫鸟人工核对 Seller Central 上传历史，并保留任务 ID 和短摘要做审计。
- “账本异常”：停止上传 path/timer，但不要删除目录；先保留 `out/product-uploads` 的只读副本并检查权限/磁盘/原子写故障。九项巡检可继续，但不得为了恢复绿色隐藏损坏任务。

排查只用以下脱敏状态，不显示 env 值或原始文件名：

```bash
systemctl show amzguard-product-upload.service -p ActiveState -p Result -p ExecMainStatus
journalctl -u amzguard-product-upload.service -n 100 --no-pager -o short-iso
find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' \) -printf '%TY-%Tm-%Td %f\n'
```

## 6. 真实业务异常

以下证据明确时属于业务异常，不应误称程序故障：

- Policy Compliance 非 `Healthy` 或 AHR 下降。
- 明确绩效告警、违规、限制或停用风险。
- 北京时间当天 Feedback 低于 4 分，或本店有效 ASIN 的 Review 低于 4 星。
- 已确认活跃商品无购物车/Buy Box，或真实评分下降。双路确认的 404 / Currently unavailable 按第 4 节归为非在售，不等同于活跃商品异常。
- 新的 Outlet Deal 活动。
- VOC 为 Poor/Very Poor、退货趋势异常。
- 广告范围内未满足对应时段的多数有效状态规则；少数例外不能单独等同于整店异常，口径见 [广告说明](../README.md#广告范围与判定)。

运营只能在人工批准的正常业务流程中处理；九项巡检不会修改 Listing、库存、价格、广告、店铺设置或 Amazon 退货记录；商品批量上传仅按 [部署中的独立授权流程](../DEPLOY.md#6-配置最小权限-environmentfile) 执行。处理后安排同店同项补跑，保留前后报告和时间线。

## 7. 钉钉或 CRM 故障

症状：报告存在，但 Dashboard 通道状态为失败，`out/alerts` 或 `out/channels/crm` 有失败审计。

```bash
systemctl show amzguard-channel-test.service -p Result -p ExecMainStatus
journalctl -u amzguard-channel-test.service -n 80 --no-pager -o short-iso
find /opt/amzguard/out/alerts /opt/amzguard/out/channels/crm \
  -maxdepth 3 -type f -printf '%TY-%Tm-%Td %TH:%TM %m %p\n' 2>/dev/null
```

常见原因：Webhook 失效、加签 Secret 不匹配、外部限流、DNS/TLS、CRM 5xx/超时、CRM endpoint 非 HTTPS、幂等账本损坏。

处理时先保证主报告未丢失。钉钉测试必须明确标记测试；CRM 测试只做 dry-run。CRM 账本损坏时不要删除账本再补跑，否则可能重复创建记录；先做只读副本、核对外部系统已存在的幂等键，再恢复。

## 8. Dashboard、Nginx 或 HTTPS

```bash
systemctl status amzguard-dashboard.service nginx.service --no-pager
journalctl -u amzguard-dashboard.service -n 100 --no-pager -o short-iso
sudo nginx -t
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://123.58.218.45/api/status
```

本机健康接口应为 `200`，未登录状态接口应为 `401`。若生产 Dashboard 因缺少可用用户或会话配置拒绝启动，这是正确的 fail-closed 行为；不要通过改为外网直监听或关闭认证绕过。

`npm run seed` 仅用于隔离本地界面演示：当前只生成前八项样例，未覆盖 Inbox，部分样例仍采用历史广告规则，不能作为最新业务判定或生产验证依据。

移动端溢出、空状态或历史合并错误属于前端/数据问题。单店补跑后验证其他店铺仍保留各自较新的结果；旧全店报告不能覆盖新的单店报告。

证书问题：

```bash
systemctl list-timers --all amzguard-cert-renew.timer
systemctl show amzguard-cert-renew.service -p Result -p ExecMainStatus
journalctl -u amzguard-cert-renew.service -n 80 --no-pager -o short-iso
openssl s_client -connect 123.58.218.45:443 -servername 123.58.218.45 </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -ext subjectAltName
```

短有效期 IP 证书必须依赖自动续期。续期服务成功但公网仍返回旧证书时，检查 deploy hook 的 Nginx reload 结果。

## 9. 运行锁与中断恢复

`out/runtime/run.lock` 防止多个 timer 或手动任务并发占用紫鸟。合法 JSON 锁记录的 PID 已不存在时，程序会将其改名为 `run.lock.stale-<时间戳>` 再取得新锁；PID 仍存在时拒绝并发。损坏 JSON 锁存在已确认缺陷：读取失败使年龄未计算，当前不会按预期的 6 小时自动过期。不要一看到锁文件就删除，也不要靠等待来掩盖该缺陷。

```bash
systemctl list-units --type=service 'amzguard-*'
ps -eo pid,lstart,cmd | grep '[n]ode /opt/amzguard/src/cli.js'
stat /opt/amzguard/out/runtime/run.lock
```

只有确认没有对应进程、没有紫鸟店铺仍在运行，并记录故障时间线后，才处理陈旧锁。优先保留或改名用于审计，不做不可恢复删除。

## 10. 敏感信息疑似泄露

立即停止把相关输出传播到聊天或工单，不继续打开文件全文。暂停 timer、保护现场、轮换相关凭据、运行历史脱敏 dry-run，并按 [SECURITY.md](SECURITY.md) 的事件流程执行。不要为了“清干净”而破坏报告时间顺序、CRM 账本或审计链。
