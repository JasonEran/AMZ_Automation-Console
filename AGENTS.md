# AGENTS.md — 给 Codex / AI Agent 的工作约定

这个仓库是「亚马逊后台自动巡检」系统，共 9 项检查；默认传输层为紫鸟官方 WebDriver HTTP + Selenium，旧 `ziniao-cli`/ZClaw 仅作兼容后备。

## 铁律

1. **绝不绕过紫鸟直接登录亚马逊后台。** Seller Central 必须运行在紫鸟启动的店铺浏览器中。默认流程是紫鸟 WebDriver `startBrowser` 返回 `debuggingPort` 后由 Selenium连接；不要用普通浏览器、curl 或独立 Playwright 访问 Seller Central，也不要向用户索要亚马逊账号密码。
2. **Amazon 写入只有一个窄例外。** 九项巡检、广告、Outlet Deal、VOC、Inbox 与其他 Amazon 操作仍严格只读。Inbox 只读列表，绝不打开消息会话（打开会把消息标记为已读）。仅允许 Dashboard 已授权用户对已预检文件完成密码再认证和精确短语确认后，由独立工作者通过对应店铺紫鸟访问精确 URL `https://sellercentral.amazon.com/product-search/bulk`；授权必须绑定任务、店铺和 SHA-256，进入文件选择/提交边界前持久化 `SUBMITTING`，结果未知时禁止自动重试。双执行闸默认关闭，禁止用脚本绕过 Dashboard 的逐任务确认。
3. **紫鸟凭据不入库。** macOS 正式运行优先用 `npm run credentials:setup` 存入登录钥匙串；其他系统用 `ZINIAO_COMPANY`、`ZINIAO_USERNAME`、`ZINIAO_PASSWORD`。不得写入 config、plist、源码或示例。钉钉/CRM 凭据同理。
4. **不要把“无法判定”当成“正常”。** 第 1 项只有 Policy Compliance=`Healthy` 才正常。第 2～9 项的异常可由任一路径发现，但正常必须同时有 DOM 与页面文本两路证据。UNKNOWN、PARTIAL_EVIDENCE 和解析失败都必须提醒。
5. **改了解析或传输逻辑就跑自检。** `node src/cli.js store-health --self-test`（离线案例数量以命令最终通过数为准）。新增规则必须同时新增断言。
6. **WebDriver 调用顺序不可破坏。** 普通紫鸟主进程完全退出后以 `--run_type=web_driver --ipc_type=http --port=...` 启动；先 `updateCore`，再 `getBrowserList/startBrowser`；HTTP 超时不得低于 120 秒；V6 启动店铺显式 `privacyMode=false`、`cookieTypeLoad=0`。

## 目录

| 路径 | 作用 |
|---|---|
| `src/cli.js` | 入口：批次、单项、doctor、stores、probe、看板 |
| `src/checks/store-health.js` | 第 1 项专用编排 |
| `src/checks/definitions.js` | 第 2～9 项页面、文本解析与判定 |
| `src/checks/asin-health.js` | 第 5 项逐 ASIN 编排 |
| `src/lib/check-runner.js` | 第 2～9 项通用双路采集、报告和报警 |
| `src/lib/reviews-collector.js` / `src/lib/review-evidence.js` | Reviews 全量分页采集、逐页截图与评价日期关联 |
| `src/intelligence/` | 独立商品档案、只读采样、变化规则、队列与 API，不调用 CRM |
| `src/web/dashboard.js` / `src/web/intelligence*` | 九个工作区与保留状态的竞品情报界面 |
| `src/lib/ziniao-webdriver.js` | 官方 WebDriver HTTP + Selenium 传输层 |
| `src/lib/ziniao.js` | 旧 CLI/ZClaw 兼容层与共用 marker 工具 |
| `src/lib/ziniao-factory.js` | 按 `ziniao.mode` 选择传输层 |
| `src/lib/product-upload.js` / `src/tools/product-upload-worker.js` | 唯一受控写入口的任务账本、安全预检与独立工作者 |
| `src/extractors/*.js` | 注入店铺页面执行的纯 ASCII ES5 脚本 |
| `src/selftest/` | 离线断言、DOM stub 和 mock 传输层 |
| `src/lib/alert.js` / `crm.js` / `report.js` / `state.js` | 报警、CRM、报表、跨次状态 |

## 常用命令

```bash
npm test
npm run doctor
npm run stores
node src/cli.js checks
node src/cli.js run-check store-health --store US-01 --no-close --log-level debug
npm run am
npm run pm
npm run ads:off
npm run ads:on
```

退出码：`0` 全部正常；`1` 有业务异常；`2` 环境或配置问题。

## 排查顺序

1. `npm test`：先确认离线逻辑。
2. `npm run doctor`：确认 WebDriver 权限、凭据、客户端路径、HTTP 端口。
3. `npm run stores`：确认 `updateCore/getBrowserList`。
4. 单店 `run-check ... --no-close --log-level debug`：检查截图、DOM 结果和页面文本。
5. 最后才根据真机证据修改 `src/extractors/` 或 `src/checks/definitions.js`，禁止靠猜选择器。

## 修改注入脚本

`src/extractors/*.js` 必须保持纯 ASCII、ES5，不得使用反引号或 `${`。这同时兼容 Selenium `executeScript` 和旧 CLI argv 传输。DOM stub 仅支持已有 API；需要新 DOM API 时先补 stub，再加断言。
