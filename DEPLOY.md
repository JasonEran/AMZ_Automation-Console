# Linux 单主机生产部署

本文描述仓库提供的生产部署目标与验收流程，不证明本地提交已部署或目标主机当前健康。生产目标：Ubuntu 主机 `123.58.218.45`，应用目录 `/opt/amzguard`。采集、报告、Dashboard、定时任务、Nginx 和紫鸟 WebDriver 都运行在同一主机。旧 `deploy/install-windows.ps1` 只保留为 fail-closed 入口，执行即报错，不用于当前生产。

源码仓库与提交范围见 [GitHub 同步说明](docs/GITHUB.md)，已交付变更见 [版本记录](docs/CHANGELOG.md)。仅同步 GitHub 或修改文档不触发生产重启；实际部署需要单独记录 Git 提交与部署清单。

任何发布都遵循“本地离线通过 → 服务器预检与备份 → 安装 → 单店真机 → 全链路验收”的顺序。不要在巡检执行中间覆盖文件或重启紫鸟。

## 1. 生产拓扑

```text
Internet :443
    ↓ Nginx（TLS、登录限流、安全头、无 query 访问日志）
127.0.0.1:4173  Dashboard/API

systemd timers
    ↓ Node.js collector
127.0.0.1:18888  紫鸟 WebDriver HTTP
    ↓ startBrowser → debuggingPort
紫鸟店铺 Chromium → Amazon（九项巡检只读）

Dashboard 二次确认 → 私有上传队列
    ↓ 独立 systemd path/timer worker（双闸默认关闭）
对应店铺紫鸟 Chromium → Seller Central 固定批量上传页

/opt/amzguard/out  报告、证据、状态、告警、通道审计
```

端口 18888 即使被紫鸟监听在非回环地址，也必须由主机防火墙和云安全组阻断；公网只开放 SSH、80 和 443。

## 2. 发布前本地门禁

在项目仓库根目录执行（现有本地工作目录为 `/Users/jasoneran/SingalApp`）：

```bash
npm ci
npm test
npm run doctor
node scripts/sanitize-history.mjs
git status --short
```

要求：

- `npm test` 已包含 Node 测试与 `store-health --self-test`；以本次实际通过结果为准，解析器或传输层改动有对应回归断言。
- `doctor` 会在紫鸟已响应且凭据齐全时调用 `updateCore`，并写本地日志；它不属于离线测试。应在没有采集任务时运行，除“本机紫鸟 WebDriver 尚未启动”等已解释条件外没有配置错误。
- 历史脱敏 dry-run 的范围已确认；如需修复，先备份后执行 `--apply`。
- 检查工作树，确认没有把 `config/config.json`、真实店铺清单、`out/`、EnvironmentFile、密钥或凭据加入部署包。
- 真机测试只通过紫鸟执行；任何普通浏览器或 HTTP 客户端都不能访问 Amazon 页面。

## 3. 服务器前置条件

- Ubuntu 24.04，时区 `Asia/Shanghai`，NTP 同步。
- Node.js 22+ 位于 `/usr/local/bin/node`。
- 紫鸟 Linux V6 位于 `/opt/ziniao/ziniaobrowser`，已由专用自动化成员正常登录并开通 WebDriver 权限。
- 已安装 `Xvfb`、`xauth`、`mcookie`、`dbus-run-session`、`xdotool`、`curl`、Nginx 与 logrotate。
- Dashboard 主入口为 `https://amzcheck.pc51.com`；域名证书安装在 `/etc/amzguard/tls/amzcheck.pc51.com/`。IP 证书仍在 `/etc/letsencrypt/live/123.58.218.45/`，续期客户端位于 `/opt/certbot-ip/bin/certbot`。
- 运行用户为 `ubuntu`；六个最小权限 EnvironmentFile 位于 `/etc/amzguard/`。
- 内核 `kernel.yama.ptrace_scope` 至少为 `2`，且重启后保持；安装与验收脚本会检查该值，但不会替主机设置它。
- 仅当商品上传双闸启用时，必须安装 ClamAV，`clamscan` 路径可执行且 `/var/lib/clamav` 存在未超过策略天数的签名；默认关闭模式不要求安装扫描器。
- 云安全组与 UFW 仅允许必要入站端口，尤其不得开放 18888 或 Chromium debuggingPort。

只读预检：

```bash
timedatectl status
/usr/local/bin/node --version
sudo nginx -t
systemctl list-units --state=failed
systemctl list-timers --all 'amzguard-*.timer'
sudo ss -lntp
```

## 4. 停止排程并备份

先检查所有 AMZ Guard 单元与待执行 job。发布窗口内停止下列 timer/path，然后等待巡检、手动补跑、情报、上传和维护 service 自然结束；安装器会拒绝任何仍为 `activating`/`active` 或已排队的相关任务：

```bash
systemctl list-units --type=service 'amzguard-*'
systemctl list-jobs --no-pager
sudo systemctl stop \
  amzguard-store-health-am.timer \
  amzguard-store-health-pm.timer \
  amzguard-store-health-ads-off.timer \
  amzguard-store-health-ads-on.timer \
  amzguard-collector-health.timer \
  amzguard-retention.timer \
  amzguard-cert-renew.timer \
  amzguard-product-upload.timer \
  amzguard-intelligence.timer
sudo systemctl stop amzguard-product-upload.path
```

创建 root-only 备份。代码与运行数据分开保存，EnvironmentFile 不复制进普通归档；它应由外部密码管理或加密备份恢复：

```bash
sudo install -d -m 0700 /var/backups/amzguard
release_stamp=$(date +%Y%m%d-%H%M%S)
sudo tar --exclude='./out' --exclude='./node_modules' \
  -C /opt/amzguard -czf "/var/backups/amzguard/app-${release_stamp}.tgz" .
sudo tar -C /opt/amzguard -czf "/var/backups/amzguard/out-${release_stamp}.tgz" out
sudo chmod 0600 "/var/backups/amzguard/app-${release_stamp}.tgz" \
  "/var/backups/amzguard/out-${release_stamp}.tgz"
```

若数据量大，应使用云盘快照或文件系统快照替代长时间 tar。不要在可写的共享目录留下 EnvironmentFile 副本。

## 5. 同步代码

生产代码由 root 持有。只对五个明确的交付目录做镜像同步；真实配置、输出和 EnvironmentFile 不在同步范围内。发布前已有 root-only 备份，因此可以删除这些专用代码目录中的陈旧文件，但不得把 `--delete` 用在 `/opt/amzguard/` 根、`config/` 或 `out/`：

```bash
for release_dir in src scripts deploy docs test; do
  rsync -az --delete --itemize-changes \
    --exclude '.DS_Store' --exclude '._*' \
    --rsync-path='sudo rsync' \
    -e "ssh -i /Users/jasoneran/SSH/AIWeb_Test_SSH.pem" \
    "/Users/jasoneran/SingalApp/${release_dir}/" \
    "ubuntu@123.58.218.45:/opt/amzguard/${release_dir}/"
done
rsync -az --itemize-changes --rsync-path='sudo rsync' \
  -e "ssh -i /Users/jasoneran/SSH/AIWeb_Test_SSH.pem" \
  /Users/jasoneran/SingalApp/{package.json,package-lock.json,README.md,DEPLOY.md,AGENTS.md} \
  ubuntu@123.58.218.45:/opt/amzguard/
rsync -az --itemize-changes --rsync-path='sudo rsync' \
  -e "ssh -i /Users/jasoneran/SSH/AIWeb_Test_SSH.pem" \
  /Users/jasoneran/SingalApp/config/{config,stores,asins}.example.json \
  ubuntu@123.58.218.45:/opt/amzguard/config/
```

确认变更清单后，在服务器以 root 安装锁定依赖，再用运行用户执行离线门禁：

```bash
cd /opt/amzguard
sudo /usr/local/bin/npm ci --omit=dev
sudo -u ubuntu /usr/local/bin/npm test
```

## 6. 配置最小权限 EnvironmentFile

全新主机先从 `config/*.example.json` 分别创建缺失的 `config.json`、`stores.json`、`asins.json`，填写实际非敏感运行参数与店铺/ASIN 范围，保留已有文件；安装器要求三者存在且 `config/` 内没有额外备份文件。随后创建 EnvironmentFile：

```bash
sudo install -d -m 0700 /etc/amzguard
for env_name in dashboard ziniao collector channels retention product-upload; do
  sudo test -e "/etc/amzguard/${env_name}.env" || sudo install -m 0600 -o root -g root \
    "/opt/amzguard/deploy/env/${env_name}.env.example" "/etc/amzguard/${env_name}.env"
done
sudoedit /etc/amzguard/dashboard.env
sudoedit /etc/amzguard/ziniao.env
sudoedit /etc/amzguard/collector.env
sudoedit /etc/amzguard/channels.env
sudoedit /etc/amzguard/retention.env
sudoedit /etc/amzguard/product-upload.env
```

`bootstrap-linux-env.sh` 是可选初始化助手，只创建 `dashboard`、`ziniao`、`channels`、`retention`、`product-upload` 五个文件，拒绝覆盖；`collector.env` 仍需从模板单独创建。它生成 Dashboard 随机凭据并保持上传关闭，但预置的 readiness hint 不代表紫鸟或钉钉已验证。不要在上面的六文件创建流程之后重复运行它。`configure-channels-linux.sh` 用于同时配置两个钉钉机器人，会覆盖 `channels.env` 并清空 CRM 字段；保留现有 CRM 时使用 `sudoedit`。

旧部署若只有 `/etc/amzguard/amzguard.env`，不要在终端复制字段值。确认六个目标文件尚不存在后，运行 allow-list 迁移器：

```bash
sudo sh /opt/amzguard/deploy/migrate-env-layout.sh
```

迁移器不会 source/eval 旧文件，也不会输出值。凭据与可变项只复制 allow-list 中最后一次出现的赋值，旧 `INGEST_TOKEN` 会仅改键名迁为 `AMZGUARD_INGEST_TOKEN`；监听地址、端口、WebDriver 模式、客户端路径和公网看板 URL 则直接写入本部署的规范安全值。所有内容先进入 root-only 临时文件再原子落位；目标文件已存在、旧文件语法异常时会拒绝执行。旧文件保持 `root:root 0600` 原位，仅用于发布回滚；新 unit 不引用它。发布验收和回滚观察期结束后，再按凭据销毁策略移除旧文件。缺失的必填值仍须用 `sudoedit` 补齐。

| 文件 | 仅供哪些服务使用 | 内容 |
|---|---|---|
| `dashboard.env` | Dashboard | 登录、Session、ingest token、独立入站 CRM 读 API 与免密配置、非秘密 readiness hint |
| `ziniao.env` | 紫鸟守护进程 | 客户端路径、HTTP 端口；不含登录凭据 |
| `collector.env` | 巡检、手动补跑、collector-health、情报与上传工作者 | 紫鸟自动化成员凭据与采集参数 |
| `channels.env` | 巡检、手动补跑、collector-health、上传工作者与通道测试 | 钉钉、CRM、HTTPS 看板入口 |
| `retention.env` | 保留任务 | 仅保留天数，无外部凭据 |
| `product-upload.env` | Dashboard 与独立上传工作者 | 双执行闸、上传管理员和扫描器策略；不得含 Dashboard/紫鸟/通道凭据 |

必须配置紫鸟三项凭据、至少 12 字符的 Dashboard 密码、至少 32 字符的随机 Session Secret、至少 32 字符的独立 ingest token，以及常规钉钉 Webhook/Secret。运维钉钉与 CRM 都是可选通道，但各自必须成对全填或全空。`dashboard.env` 的三个 `AMZGUARD_*_CONFIGURED` 是不含秘密的 readiness hint：紫鸟和常规钉钉在生产必须为 `1`；CRM 按 `channels.env` 是否成对配置写 `1` 或 `0`。商品上传的 `AMZGUARD_PRODUCT_UPLOAD_ENABLED` 与 `AMZGUARD_PRODUCT_UPLOAD_EXECUTION_ENABLED` 必须同为 `0` 或同为 `1`，生产模板默认 `0/0`；启用时上传管理员必须与 Dashboard 登录名完全一致。单主机 Nginx 阻断公网 `/api/ingest`；应用层 token 是第二道 fail-closed 防线。不要把值放进命令行、聊天、日志或配置 JSON。

商品上传从关闭切换为启用前，必须先完成：安装并更新 ClamAV 签名、用只读探针经对应紫鸟确认精确页面与唯一控件结构、离线回归全通过、确认待处理目录没有历史队列、再把双闸同时改为 `1`。启用只允许工作者消费 Dashboard 逐任务确认生成的队列；不得手工创建 queue marker 或直接运行带文件参数的脚本。真机提交必须使用业务批准的真实模板，禁止为测试制造虚假商品数据。

CRM 入站只读 API 使用 `dashboard.env` 的独立 `AMZGUARD_CRM_*` 配置，不复用上述出站 `CRM_ENDPOINT/CRM_TOKEN`，也不影响 `AMZGUARD_CRM_CONFIGURED` readiness hint。变量要求、关闭方式及弹窗/HTTPS 回调两种免密模式的启用条件集中在 [CRM API 配置](docs/CRM_API.md#6-监测站配置)。更新现有服务时保留 env、运行数据与实际 timer 状态，只发布经过验证的文件并重启 Dashboard；不要为添加这些变量重跑初始化器或安装器。浏览器免密状态保存在内存，Dashboard 重启后需要从 CRM 重新进入。

前端店铺配置写入 `out/runtime/store-registry.json`，显示配置写入 `out/runtime/ui-config.json`，沿用 Dashboard 的 `out/` 写权限，无需放宽只读代码或 `config/` 目录。首次保存后的管理文件优先于 bootstrap；发布及回滚不得覆盖或删除它们，备份包含这两项和既有广告/用户配置。配置功能同时修改 CLI 加载器，发布前应确认采集/上传工作者空闲，并保留现有 timer/path 状态；保存店铺不触发采集。操作与管理 API 见 [配置管理](docs/OPERATIONS.md#店铺与页面配置)。

只检查键名、属主和权限，不输出值：

```bash
sudo stat -c '%U:%G %a %n' /etc/amzguard/{dashboard,ziniao,collector,channels,retention,product-upload}.env
for env_file in /etc/amzguard/{dashboard,ziniao,collector,channels,retention,product-upload}.env; do
  sudo awk -F= '/^[A-Z][A-Z0-9_]*=/{print FILENAME ":" $1}' "$env_file"
done
```

`/opt/amzguard` 与代码、模板、依赖必须由 `root:root` 持有；`config/` 为 `root:ubuntu 0750`，仅三个真实 JSON 为 `ubuntu:ubuntu 0600`；`out/` 为 `ubuntu:ubuntu 0700`。运行配置不得出现任何凭据或带认证 query 的 URL。

## 7. TLS 与网络边界

安装脚本要求 IP 和域名两套证书都已存在。当前 IP 证书为短有效期证书，不能只依赖到期日前人工处理；`amzguard-cert-renew.timer` 每日两次检查并在成功续期后 reload Nginx。

`amzcheck.pc51.com` 使用运营方提供的 `*.pc51.com` 证书，证书链与私钥分别安装为 `/etc/amzguard/tls/amzcheck.pc51.com/fullchain.pem`（`0644`）和 `privkey.pem`（`0600`），目录为 root 持有的 `0700`。该外部签发证书不由现有 IP certbot 自动续期；更换前必须先核对 SAN、有效期和公私钥匹配，再执行 `nginx -t` 与 reload。验收脚本会在剩余有效期不足 30 天时失败。

先在云控制台确认安全组，再配置 UFW。启用前必须确认 SSH 规则有效：

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 18888/tcp
sudo ufw --force enable
sudo ufw status verbose
```

Nginx 的 HTTP 重定向会丢弃 query，HTTP/HTTPS 专用访问日志也只记录 `$uri`，避免临时认证参数进入日志。

## 8. 安装 systemd、Nginx 与 logrotate

```bash
cd /opt/amzguard
sudo sh deploy/install-linux.sh
```

脚本会：

- 检查运行用户、Node、紫鸟、图形依赖、证书、配置与 EnvironmentFile。
- 校验最小权限 env 的语法、重复键、必填/成对键和 readiness hint，拒绝旧全量 env 引用。
- 确认普通紫鸟已退出、18888 未暴露且已有监听只属于 `ubuntu` 下的受管紫鸟 cgroup。
- 若相关 timer/path 未停止、巡检/手动/情报/上传/维护任务仍在运行或排队，或运行锁仍存在，则中止，避免中途杀死店铺浏览器。
- 用 `systemd-analyze verify` 校验 unit，并校验 Nginx 与 logrotate 配置。
- 安装并启用 Xvfb、紫鸟、Dashboard、四个业务 timer、采集健康、情报、证据保留和证书续期 timer；仅在商品上传双闸开启时启用其 path 与一分钟兜底 timer，关闭时明确保持 disabled/inactive。
- 修正 `config/`、`out/` 和紫鸟所需用户目录的属主与最小权限。
- 生成 `/opt/amzguard/DEPLOYED_MANIFEST.sha256`，用于版本一致性核验。

## 9. 发布后验收

### 服务和定时器

```bash
sudo sh /opt/amzguard/deploy/verify-linux.sh
systemctl is-enabled amzguard-xvfb.service amzguard-ziniao.service amzguard-dashboard.service
systemctl is-active amzguard-xvfb.service amzguard-ziniao.service amzguard-dashboard.service nginx.service
systemctl list-timers --all 'amzguard-*.timer'
sudo systemd-analyze verify /etc/systemd/system/amzguard-*.service /etc/systemd/system/amzguard-*.timer /etc/systemd/system/amzguard-*.path
```

验收脚本检查服务、timer、权限、监听地址、UFW、HTTPS/登录/API、证书和部署清单；不访问 Amazon，不触发业务任务或通知。它读取上传策略，并读取域名私钥以计算公钥摘要匹配证书，不回显秘密；还向公网 `/api/ingest` 发出无令牌、无业务正文的 POST，确认 Nginx 返回 `404`。业务时段必须显示北京时间 08:00、11:20、15:30、18:30；以 `list-timers` 的 `NEXT` 列作为下一次执行时间，不手工推算。

### Dashboard、HTTPS 与登录保护

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://amzcheck.pc51.com/
curl -sS -o /dev/null -w '%{http_code}\n' https://amzcheck.pc51.com/api/status
openssl s_client -connect 123.58.218.45:443 -servername amzcheck.pc51.com </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -ext subjectAltName
```

期望：本机健康接口 `200`；未登录主页直接呈现登录页 `200`；未登录 `/api/status` 为 `401`；域名证书 SAN 覆盖 `amzcheck.pc51.com` 且有效期至少还有 30 天。不要在命令行传 Dashboard 密码。

### 本地与服务器版本一致性

服务器先验证部署后文件没有漂移：

```bash
cd /opt/amzguard
sha256sum -c DEPLOYED_MANIFEST.sha256
```

再从本地比较同一套非敏感交付文件；没有 diff 输出才算一致：

```bash
diff -u \
  <(cd /Users/jasoneran/SingalApp && sh deploy/manifest.sh .) \
  <(ssh -i /Users/jasoneran/SSH/AIWeb_Test_SSH.pem ubuntu@123.58.218.45 \
    'sudo cat /opt/amzguard/DEPLOYED_MANIFEST.sha256')
```

真实运行配置和 `out/` 有意不进入清单，分别通过权限、配置审计和报告验收确认。

### 紫鸟授权和单店真机

```bash
sudo systemctl start amzguard-collector-health.service
systemctl show amzguard-collector-health.service -p Result -p ExecMainStatus
journalctl -u amzguard-collector-health.service -n 80 --no-pager

sudo systemctl start --no-block 'amzguard-manual@store-health:XCAI.service'
journalctl -fu 'amzguard-manual@store-health:XCAI.service'
```

将 `XCAI` 替换成当前有效店铺清单中仅含字母、数字、点、下划线或连字符的真实 `key`。单店健康通过后，按失败项针对性补跑；不要直接用普通 Chrome 验证 Amazon。

### 通道

```bash
cd /opt/amzguard
sudo systemctl start --no-block 'amzguard-manual@store-health:XCAI.service'
sudo -u ubuntu find out/alerts out/channels/crm -maxdepth 3 -type f -printf '%m %p\n' 2>/dev/null
```

钉钉连通测试只能由明确授权的维护窗口执行 `node src/cli.js test-notify`，消息会标记“测试消息”。CRM 同一命令只做 dry-run，不写虚假数据。具体做法见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

### 重启恢复

在维护窗口执行服务器重启验收，重启后重复服务、timer、HTTPS、登录保护与 collector-health 检查。带 `OnCalendar` 与 `Persistent=true` 的 timer 会在恢复后补跑错过的时点；应检查是否因此立即触发，并确认全局运行锁没有把同一紫鸟环境并发打开。

## 10. 回滚

程序回归且无法在发布窗口修复时：

1. 按第 4 节停止所有 AMZ Guard timer 及上传 path，等待巡检、手动、情报、上传和维护任务自然结束。
2. 停止 Dashboard 与紫鸟服务。
3. 把对应版本的 `app-<timestamp>.tgz` 解压到隔离目录，核对后再覆盖 `/opt/amzguard` 中的代码文件；不要覆盖 `out/` 和当前 EnvironmentFile。
4. `sudo /usr/local/bin/npm ci --omit=dev`，以 `ubuntu` 运行离线测试，再执行 `sudo sh deploy/install-linux.sh`。
5. 若数据迁移本身有问题，先保留故障现场，再从对应的 `out-<timestamp>.tgz` 恢复到隔离目录进行差异确认；不要直接删除现有报告。
6. 记录回滚原因、部署清单哈希和最终服务状态。

完整日常命令、退出码解释和恢复清单见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 独立竞品情报发布验收

新增 `amzguard-intelligence.service/.timer`，仅加载 `collector.env`，不加载 CRM/通知凭据。安装器会启用五分钟队列检查；空名单及周期采集关闭时不访问 Amazon。部署前也停止该 timer 并等待对应 service 收尾；它使用原共享运行锁。

验收 `/#intelligence` 的登录保护、旧 `/intelligence` 在登录后的 303 跳转、`/api/intelligence` 的未登录 401，以及已登录状态的空名单/已有档案。切换情报与巡检栏目时应保留十个导航入口、搜索和标签状态，不发生整页重载；验证浏览器前进/后退。不得把本地界面演示数据发布到生产；真实只读采样通过既有紫鸟会话完成。细节见 [INTELLIGENCE_V1.md](docs/INTELLIGENCE_V1.md)。
