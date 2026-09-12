# 安全基线与事件响应

本系统处理店铺运营数据、客户反馈、页面证据和外部系统凭据。安全目标是：Amazon 访问路径不可绕过紫鸟、九项巡检零写入、唯一批量上传写入口具备逐任务授权和不可重试边界、明文凭据不进入应用数据、无法判定不被粉饰、证据可审计且最小暴露。

## Amazon 只读边界与唯一写入例外

所有 Seller Central、Amazon Ads 和 Amazon 商品页必须位于紫鸟 `startBrowser` 启动的对应店铺 Chromium 中，Selenium 仅连接其 `debuggingPort`。

允许：

- 打开页面和只读导航。
- 点击只读标签、筛选器、分页和 ASIN/VOC 详情。
- 读取 DOM、可见文本、只读指标并保存必要证据。

禁止：

- 修改 Listing、库存、价格、广告、店铺设置或退货状态。
- 创建、提交、编辑或删除 Outlet Deal。
- 开启、暂停、关闭广告。
- 点击 Save、Submit、Create、Delete、Enable、Pause 等改变状态的控件。
- 在 Amazon 后台登记退货；“登记”只表示写本地数据或 CRM。
- 打开 Inbox 消息会话、标记已读或回复消息；该项只读列表，打开会话本身会改变已读状态。
- 使用普通 Chrome、独立 Playwright/Puppeteer、HTTP 客户端或其他路径访问 Amazon。

唯一例外是已确认的 Seller Central 商品批量上传。它必须同时满足：Dashboard 已认证且具备上传角色、CSRF/同源校验通过、对已预检文件完成密码再认证和精确短语确认、授权绑定任务 ID/店铺/完整 SHA-256/大小/有效期、固定精确 URL `https://sellercentral.amazon.com/product-search/bulk`、只存在唯一文件控件和白名单提交控件、通过对应店铺紫鸟、独立工作者双闸开启且安全扫描通过。文件选择前即持久化 `SUBMITTING`；一旦越过边界，超时、崩溃或结果冲突都进入 `UNKNOWN`，禁止自动重试。每个真实文件必须逐任务确认，禁止批量预授权或脚本绕过 Dashboard。

解析与交互代码审查必须把可点击控件当作高风险面。除上述精确例外外，新增 Amazon 点击动作必须证明它属于只读或获批登录流程，并有离线断言。

## 登录与验证码

紫鸟负责 Amazon 账号、密码、Passkey 与验证码填充。程序只允许已有登录流程中的白名单动作：

1. 选择唯一可确认的已有 Amazon 账户卡；账户切换页按配置选择市场并确认，不创建新账户。
2. 对紫鸟已填的账号点击 Continue，或点击使用紫鸟 Passkey 登录。
3. 在已识别的 MFA 流程中选择受控验证方式、发送一次性密码或点击接受验证码；具体条件和有限重试见[登录与会话排障](TROUBLESHOOTING.md#3-登录或会话问题)。
4. 仅依据页面内 `:placeholder-shown`、必填约束、ValidityState 和 `aria-invalid` 等布尔状态判断验证码字段是否具备可提交信号；不读取字段值或长度，Selenium 只接收布尔值。缺少可信非空信号时拒绝提交。
5. 点击登录并等待认证成功。

程序不得读取或返回密码/验证码字符串，不得比较或缓存前一个验证码，不得把认证页面文本、DOM 或截图落盘。认证失败输出只记录状态分类和时间，不记录账号标识、SSO/OpenID 参数或字段值。

## 凭据存放

| 凭据 | macOS | Linux 生产 |
|---|---|---|
| 紫鸟企业/成员/密码 | 登录 Keychain | `/etc/amzguard/collector.env` |
| 紫鸟客户端路径/端口 | 普通配置 | `/etc/amzguard/ziniao.env`（无登录凭据） |
| 钉钉 Webhook/加签 Secret | 登录 Keychain | `/etc/amzguard/channels.env` |
| CRM endpoint/Token | Keychain 或进程环境 | `/etc/amzguard/channels.env` |
| CRM 入站读 API 独立 Token/店铺范围/HTTPS 回调 | 进程环境 | `/etc/amzguard/dashboard.env` |
| Dashboard 首次管理员密码/Session/ingest token | 进程环境 | `/etc/amzguard/dashboard.env` |
| 保留天数 | 普通配置 | `/etc/amzguard/retention.env` |
| 商品上传双闸/管理员/扫描器策略 | 普通配置 | `/etc/amzguard/product-upload.env`（不得包含 Dashboard 或紫鸟凭据） |
| SSH 私钥 | 本地 `0600` 文件 | 不复制到生产服务器 |

六个生产 EnvironmentFile 必须为 `root:root 0600`。systemd 只把 `dashboard`、`ziniao`、`collector`、`channels`、`retention` 或 `product-upload` 中完成当前职责所需的文件交给对应 unit；Dashboard unit 只注入 `dashboard.env` 和无凭据的 `product-upload.env`，上传工作者不注入 `dashboard.env`。禁止恢复全量共享 env。不要用 `env`、`printenv`、`systemctl show-environment`、调试转储或 shell tracing 检查值。

Dashboard 账户保存在私有的 `out/runtime/users.json`，其中密码仅以随机盐和 scrypt 哈希形式保存。`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` 仅在用户库不存在时建立首个管理员；修改这两个环境变量不会覆盖已有账户。后续密码应通过“用户管理”中的改密或管理员重置更新，不能删除用户库来轮换密码。

店铺和显示配置仅向 Dashboard 管理员开放写入，需同源、有效 CSRF 和当前管理员会话；读取请求体后再次核对权限。店铺 key 不可更改，隐藏旧不透明绑定，只接收明确字段及允许的 Amazon 主机名。修改绑定/启停使用共享运行锁，未完成或未知上传任务阻止改绑定或停用，慢文件上传在暂存前再次核对绑定。CRM 授权不随新增店铺扩大，凭据和上传闸不进入配置表单。持久化、冲突和恢复约定见 [配置管理](OPERATIONS.md#店铺与页面配置)。

CRM 入站接口与 Dashboard 用户体系隔离：后端令牌只授予明确店铺名单，浏览器票据绑定发起握手的浏览器及单店，兑换后仅取得独立只读 Cookie。不能用于原 Dashboard API、上传、补跑或竞品情报；两种会话同时存在时仍分别检查各自权限。CRM 签票端必须独立检查其当前用户和店铺授权，不能向浏览器下发机器令牌。弹窗模式仅与显式配置的 CRM origin 通信，双向核对 origin、窗口句柄和本次握手；HTTP CRM 的既有页面及用户 Token 传输风险不会因此消失。旧重定向模式仍要求有效的 HTTPS 回调。接口不返回截图、原始页面、内部路径和 Inbox 消息实体；详见 [认证与免密协议](CRM_API.md)。

启用商品上传时，服务启动检查 `AMZGUARD_PRODUCT_UPLOAD_ADMIN_USERNAME` 是否匹配用户库中已启用的管理员；Linux 安装脚本还要求它等于 `dashboard.env` 中的 `DASHBOARD_USERNAME`。当前启动校验要求 `admin`，运行期上传资格却只按配置用户名匹配；角色降级后重新登录仍可能取得上传角色。两处授权条件的差异尚待确认，不能仅凭旧会话失效认定上传权限已撤销。

以下位置永远不能保存凭据：源码、Git、`config/*.json`、示例文件、systemd unit、Nginx 配置、日志、报告、CSV/HTML、截图、测试 fixture、工单和聊天。

配置加载器会拒绝含内联凭据的应用配置 JSON。macOS 旧配置迁移先 dry-run 后 `--apply`。Linux 从旧全量 env 升级时使用 `deploy/migrate-env-layout.sh`：它不执行旧文件、不输出值，只复制 allow-list 键并拒绝覆盖已存在的目标；缺失项再通过 `sudoedit` 补齐。旧文件只在 root-only 状态下保留到回滚观察期结束，新 unit 永不引用它。

## 网络与服务边界

- Dashboard Node 服务只监听 `127.0.0.1:4173`。
- Nginx 是唯一公网入口，提供 TLS、HSTS、登录限流、frame deny、no-sniff、referrer policy 和权限策略。
- HTTP 重定向丢弃 query；专用 Nginx access log 只记录 `$uri`。不可自定义格式的 Nginx error log 只保留 `crit`，避免常规上游错误携带原始请求 URI；Dashboard/采集可用性由 systemd、journald 和 collector-health 观测。
- 紫鸟 18888 与所有 Chromium debuggingPort 禁止公网访问。UFW 和云安全组只开放 22、80、443。
- `TRUST_PROXY=1` 仅在 Dashboard 只接受本机 Nginx 连接时使用；禁止让外部客户端直连 4173。
- 非回环或生产模式下不存在 Dashboard 用户时服务必须 fail closed。启用认证时 Session Secret 至少 32 字符；账户改密、角色或启用状态变更会使该账户旧会话立即失效，轮换 Session Secret 并重启 Dashboard 会使全部旧会话失效。会话最长有效期为 12 小时。
- 生产 `/api/ingest` 使用至少 32 字符的高熵 token，与 UI 会话相互独立；单主机 Nginx 模板额外阻断其公网访问，采集器也不设置 `AMZGUARD_INGEST` URL。引入独立采集机时必须经过安全评审，只使用 HTTPS、配置源 IP allow-list，并在两端配置同一 token。

## 主机与文件权限

- `out/` 目录及子目录 `0700`，普通文件 `0600`，属主 `ubuntu:ubuntu`。证据清理失败时自动隔离到 `.evidence-quarantine/` 的文件须保持 `000`，不能按普通证据恢复为可读。
- 拆分 EnvironmentFile 和 TLS 私钥 `0600`，由 root 管理；代码、模板、依赖和部署清单由 root 持有；真实运行配置 `ubuntu:ubuntu 0600`，配置目录 `root:ubuntu 0750`。
- systemd service 以非 root 的 `ubuntu` 运行；启用 `NoNewPrivileges`、私有临时目录、`ProtectSystem=strict`、受限 home 和精确 `ReadWritePaths`/`ReadOnlyPaths`。
- 同 UID 服务隔离依赖 Linux Yama `kernel.yama.ptrace_scope >= 2`，阻止采集器、浏览器或 Dashboard 读取彼此的 `/proc/<pid>/environ`；安装与验收脚本对此 fail closed。降低该值前必须先完成独立运行用户架构评审。
- Xvfb 使用随机 Xauthority，`-nolisten tcp`；紫鸟使用专用 runtime 目录。
- Dashboard、紫鸟和 Xvfb 由 systemd 自动重启，timer 使用 `Persistent=true`。
- Nginx、应用日志与证据有保留策略；状态基线、CRM 成功账本和最新报告不随普通证据清理。Nginx 日志保持 `www-data:adm 0640`，不能交给运行采集器的 `ubuntu` 用户。
- 商品上传原始文件仅保存在 `out/product-uploads/jobs/<job-id>/` 私有目录，目录 `0700`、文件 `0600`；暂存确认有效期为 30 分钟，过期后不得提交。列表刷新或新建暂存触发过期检查时会清除仍处于 `STAGED` 的过期 payload；保留任务按文件年龄清理其余 payload，默认 7 天，不保证到第 30 分钟即时删除。任务账本和脱敏审计按审计保留期保存。单文件、总暂存量、并发、队列和磁盘余量均有限额。
- Linux 生产 unit 通过拆分环境文件隔离凭据：Dashboard 不获得紫鸟或通道凭据，独立上传工作者不获得 Dashboard 密码或 Session Secret。此隔离依赖部署配置，不能当作 macOS 开发进程或任意继承环境的代码保证。上传双闸默认关闭，关闭时 path/timer 必须 disabled/inactive。

权限审计：

```bash
sudo stat -c '%U:%G %a %n' /etc/amzguard/{dashboard,ziniao,collector,channels,retention,product-upload}.env
sysctl kernel.yama.ptrace_scope
find /opt/amzguard/out -xdev -type d ! -perm 0700 -printf '%m %p\n'
find /opt/amzguard/out -xdev -path /opt/amzguard/out/.evidence-quarantine -prune -o -type f ! -perm 0600 -printf '%m %p\n'
find /opt/amzguard/out/.evidence-quarantine -xdev -type f ! -perm 000 -printf '%m %p\n'  # 仅在隔离目录存在时检查
sudo ufw status verbose
sudo ss -lntp
```

## 报告与客户数据

- 报告和告警中的结构化业务数据经过递归脱敏；URL 去除 query、fragment、userinfo 和认证参数。用户密码哈希、上传原文件及其私有任务账本按各自存储规则处理，原始截图不做像素脱敏，不能据此声称所有文件都已自动脱敏。
- API 返回相对证据引用，不暴露 `/opt/amzguard` 等绝对路径。
- 日志不得记录紫鸟 `browserOauth`、Cookie、Authorization、OTP、SSO/OpenID 参数或外部响应正文。
- 登录、MFA、账户选择、拦截等敏感页面不保存原文或截图。
- Feedback、Review、VOC 和退货数据只采集业务所需字段，避免额外客户身份信息。
- CRM 仅发送结构化最小记录，使用稳定幂等键；审计记录状态码和错误类别，不保存响应正文或 Authorization。
- 钉钉内容包括店铺、检查项、状态、关键数据、时间和 HTTPS 看板入口；测试消息必须明确标记。

历史报告脱敏：

```bash
cd /opt/amzguard
sudo -u ubuntu /usr/local/bin/node scripts/sanitize-history.mjs --dir /opt/amzguard/out
```

默认只统计文件数和字节数，不输出原值。备份并确认范围后才加 `--apply`；脚本采用同目录原子替换并保留原 mtime，因此不会打乱报告时间顺序。它只处理文本文件，图片需要单独人工处置。

## 安全发布检查

发布前只输出可疑文件路径，不输出匹配内容：

```bash
cd /Users/jasoneran/SingalApp
rg --no-ignore -l \
  '(access_token=|Authorization[[:space:]]*[:=]|DINGTALK_SECRET[[:space:]]*=[^[:space:]]|ZINIAO_PASSWORD[[:space:]]*=[^[:space:]])' \
  --glob '!node_modules/**' --glob '!out/**' --glob '!.git/**'
npm test
```

命中示例文件的空键或占位符不等于泄露，但每个路径都要人工确认。不要把扫描命令改成输出匹配行。

发布后验证：

1. EnvironmentFile 与 TLS 私钥权限正确。
2. 4173、18888 和 debuggingPort 不可从公网访问。
3. HTTP 自动转 HTTPS，未登录 `/api/status` 返回 `401`。
4. TLS SAN 与有效期正确，续期 timer 最近执行成功。
5. systemd 单元以 `ubuntu` 运行且 sandbox 生效。
6. 历史脱敏 dry-run 无未解释命中。
7. Dashboard 不显示绝对路径、query、fragment、凭据、OTP 或内部令牌。
8. 核对线上实际部署清单、版本与本次已验收的发布包一致；本地提交或离线测试通过不能证明生产已部署。

## 安全事件响应

发现凭据、OTP、SSO/OpenID 参数、客户敏感数据或绝对内部路径进入不当位置时：

### 1. 遏制

- 停止传播，不把原文复制到工单、聊天或新的日志。
- 暂停四个业务 timer、collector-health timer，以及商品上传 path/timer；等待正在执行的采集或上传工作者自然结束，不在提交边界中强杀进程。
- 若 Dashboard 正在暴露敏感证据，先停止 Dashboard 或在 Nginx 层限制访问，不关闭主机审计日志。
- 记录发现时间、文件路径、报告 runId、涉及通道和可能访问者；不要记录秘密值。

### 2. 保存证据

- 将受影响文件按精确路径复制到 root-only 隔离目录，保留权限、mtime 和哈希。
- 不使用宽泛递归删除，不破坏报告顺序、CRM 账本或告警链。
- 图片疑似含密码/OTP 时立即从 Dashboard 可访问位置移到 `0700` 隔离目录；报告标记证据已隔离，而不是伪造缺失原因。

### 3. 轮换

按影响范围在权威系统轮换：紫鸟自动化成员凭据、钉钉机器人 Webhook/Secret、CRM Token、Dashboard 密码/Session Secret、ingest token。SSH 私钥疑似泄露时撤销对应公钥并换新，绝不把私钥内容发送到服务器或工单。

使用对应的 `sudoedit /etc/amzguard/<scope>.env` 更新 Linux 环境凭据。已有 Dashboard 账户通过用户管理改密或重置；只改 `dashboard.env` 中的首次管理员密码不会轮换已有账户。Session Secret 或 ingest token 更新后重启 Dashboard；紫鸟成员凭据只更新 `collector.env`，无活动采集时再运行 collector-health。不要把拆分值重新汇总进临时文件。

### 4. 清理与验证

1. 对 `out/` 运行历史脱敏 dry-run，备份后 `--apply`。
2. 对源码、配置、部署包、备份、日志和工单附件做路径级扫描。
3. 对图片逐个审查；精确隔离或按保留策略销毁，不批量误删业务证据。
4. 本地离线测试、单店真机、Dashboard/API、钉钉和 CRM dry-run 全部复验。
5. 确认新报告不会再次产生同类泄露，再恢复 timer。

### 5. 复盘

记录根因、暴露窗口、访问范围、轮换项目、清理文件数、验证证据和防复发测试。复盘中使用凭据类型和哈希/标识，不使用真实值。

## 安全例外

不能为了可用性临时绕过紫鸟、关闭 Dashboard 登录、开放 18888、把凭据写进配置、保存认证页证据、降低双路判定或执行受控商品上传以外的 Amazon 写操作。商品上传也不得跳过前述逐任务授权及提交边界。若官方服务不可用且安全替代路径已穷尽，系统应保持失败/未知并告警，等待外部条件恢复。
