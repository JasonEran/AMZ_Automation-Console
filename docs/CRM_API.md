# CRM 店铺监测 API 接入文档

服务地址：`https://amzcheck.pc51.com`

接口前缀：`/api/crm/v1`，响应版本：`1.0`

CRM 后端通过这组接口读取九项店铺监测数据，主要有两种用法：

| CRM 要做什么 | 使用哪个接口 |
|---|---|
| 在店铺页面显示最新检查结论、异常和采集时间 | `results`：探测结果 |
| 获取某次检查保存的评价、ASIN、VOC 等明细 | `runs` 选择批次，再用 `data` 分页读取 |

接口读取监测站**已经保存的数据**，调用不会触发 Amazon 采集，也不会向 CRM 写入数据。本期不提供竞品情报、补跑、上传或店铺管理接口。CRM 若要增加“打开监测详情”按钮，可再接入[免密跳转](#5-免密跳转可选)，后端取数不依赖这一步。

完整字段和类型见 [OpenAPI 文档](crm-openapi.json)。也可携带下文的 Bearer 令牌请求 `GET /api/crm/v1/openapi.json` 获取在线版本。

## 1. 先接通一个店铺

### 准备令牌和店铺映射

向监测站运维取得后端专用令牌，每次请求带上：

```http
Authorization: Bearer <CRM_BACKEND_TOKEN>
Accept: application/json
```

令牌只保存在 CRM 后端的环境变量或密钥管理系统中，不下发到网页，不放在 URL、源码、工单或日志里。它与 CRM 登录 Token、Dashboard 密码、Session Secret、ingest token、出站 `CRM_TOKEN` 都不通用。请求使用上面的 HTTPS 服务地址；接口不支持网页跨域直连。

接入时先调用这两个接口：

| 请求 | 返回内容 |
|---|---|
| `GET /api/crm/v1` | 当前授权店铺、检查目录 `data.checks`、数据过期阈值、`ssoAvailable` |
| `GET /api/crm/v1/stores` | 当前可读取的店铺列表；每店包含 `storeKey`、`storeName`、`market` |

**用 `storeKey` 建立 CRM 店铺映射。** CRM 的店铺 `id` 与它不是同一个标识，不能直接互换，也不要按展示名称匹配。CRM 后端向用户提供数据前，仍需检查该用户在 CRM 中的店铺权限。

店铺列表只返回当前令牌获准访问且已启用的店铺。店铺停用后不再可读；新增店铺需要运维另行授权，展示名称变化不影响 `storeKey`。

### 最小调用示例

以下代码在 CRM 后端运行，使用支持 `fetch` 和 `AbortSignal.timeout` 的 Node.js。`storeKey` 取自上一步建立的授权映射；`US-DEMO` 只是示例值。

```js
const origin = 'https://amzcheck.pc51.com';
const token = process.env.AMZGUARD_CRM_API_TOKEN;
if (!token) throw new Error('Missing CRM backend credential');

async function read(path) {
  const response = await fetch(origin + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok) {
    // 按 HTTP 状态和 code 处理；日志只记录错误码与 requestId。
    throw Object.assign(new Error(`AMZ API ${response.status}`), {
      status: response.status,
      code: body.code,
      requestId: response.headers.get('x-request-id'),
    });
  }
  return body;
}

const storeKey = 'US-DEMO'; // 替换为当前 CRM 用户有权查看的店铺映射值。
const base = '/api/crm/v1/stores/' + encodeURIComponent(storeKey);
const response = await read(base + '/results');
const checks = response.data.checks;
```

### 响应怎么读

成功的 JSON 响应都有 `apiVersion`、`requestId`、`generatedAt` 和 `data`。数据接口另有 `pagination` 和 `metadata`；能力、票据、会话、退出接口没有这两项。OpenAPI 文件、HTML 和 303 跳转使用各自的格式。

| 字段 | 读取方式 |
|---|---|
| `data` | 实际业务内容；`results` 是对象，店铺、批次和明细列表是数组 |
| `generatedAt` | 这次 API 响应的生成时间，**不是 Amazon 采集时间** |
| `pagination` | 列表分页信息；不分页的数据接口返回 `null` |
| `metadata.staleAfterMs` | 数据过期阈值，单位毫秒 |
| `metadata.ignoredReports` | 被排除的无效报告数；大于 0 时，需提示保存数据的覆盖不完整 |
| `requestId` | 排查请求用的编号，也在 `X-Request-Id` 响应头中返回 |

业务字段中的 `null` 表示缺失或无法判定，不能转换成 0 或“正常”。响应时间和 `source` 中的采集时间使用 ISO 8601；明细中的历史日期字段保留各自类型，见 OpenAPI。日期参数使用北京时间的 `YYYY-MM-DD`。接口响应带 `Cache-Control: no-store`。

## 2. 读取探测结果

```http
GET /api/crm/v1/stores/{storeKey}/results
```

不接受 query 参数。响应的 `data` 包含 `store` 和 `checks`；`checks` 固定包含九项检查。

### 页面重点使用的字段

| 位置 | 字段 | 用途 |
|---|---|---|
| 每个 check | `checkId`、`checkNo`、`title` | 检查标识、编号和名称 |
| 每个 check | `status`、`severity`、`stale` | 汇总状态、严重程度、是否过期；这里的 **`status` 是数组** |
| 每个 check | `resultCount`、`results` | 结果数量和逐条结果；一项检查可能有多个 ASIN 结果 |
| 每条 result | `status`、`severity`、`ok`、`actionState` | 逐条状态及展示依据；这里的 `status` 是字符串 |
| 每条 result | `businessStatus`、`collectionStatus`、`confidence` | 区分业务异常、采集问题和证据可信度 |
| 每条 result | `metrics` | 对应检查的指标；字段随检查类型变化 |
| 每条 result | `source` | 原始批次、快照、采集时间和新鲜度 |
| 每条 result | `evidence` | DOM 与页面文本两路证据的可用性 |

`actionState` 有三个值：`NORMAL`（正常）、`BUSINESS`（业务需处理）、`COLLECTION`（采集需处理）。展示时同时保留状态和新鲜度，不要只取一个计数决定是否显示绿色。

以下情况需要单独处理：

- **暂无可用报告**：check 返回 `status: ["NEVER_RUN"]`、`severity: null`、`results: []`。页面显示“暂无可用结果”；这也可能由无效报告被排除导致，不能仅凭该状态断定从未采集。
- **无法判定或证据不足**：`UNKNOWN`、`PARTIAL_EVIDENCE`、未识别状态、双路冲突都需要提醒。`ERROR` 不代表已经确认业务违规。
- **数据过期**：显示采集时间和过期提示。阈值来自 `REPORT_STALE_HOURS`，默认 36 小时，有效数值最低为 1 小时；以响应中的阈值为准。
- **历史标记矛盾**：API 会保守调整展示用的 `severity/ok/actionState`，并用 `presentationAdjusted` 标明。`recordedSeverity/recordedOk` 保留历史原值，保存文件不会被改写。

`evidence.dom/text.available` 只说明对应证据对象非空且未标记 error；`bothAvailable=true` 也不能证明分页完整或判定正确。仍要结合状态、可信度、分页覆盖和新鲜度。

### 采集时间取哪里

使用每条结果的 `source.collectedAt`，并同时查看 `timeSource`、`timestampValid` 和 `stale`。`source` 还提供 `runId/snapshotId/checkedAt/collectionDate/reportStartedAt/reportFinishedAt/ageMs`，完整类型见 OpenAPI。

最新结果可能合并了不同批次。例如，只补跑一个 ASIN 后，其他 ASIN 仍保留原来的采集时间。缺少 `checkedAt` 时，时间依次取报告结束、开始、接收时间，最后才取文件 mtime；`timeSource` 会指出来源，mtime 不能证明实际采集时间。

CRM 多刷新几次接口，只会重读保存结果，不会提高 Amazon 的采样频率。

### 九项检查的标识

建议从 `GET /api/crm/v1` 的 `data.checks` 生成检查选项，每项包含 `{id,no,title,scope}`，无需在 CRM 重复维护名称。下表便于联调查阅；编号是历史标识，不代表页面顺序。

| 编号 | checkId | 检查 |
|---|---|---|
| 1 | `store-health` | 店铺健康 |
| 2 | `performance` | 绩效未处理检查 |
| 3 | `feedback` | Feedback |
| 4 | `reviews` | Reviews |
| 5 | `asin-health` | ASIN 状态 |
| 6 | `outlet` | Outlet Deal |
| 7 | `voc` | Voice of the Customer |
| 8 | `ads-status` | 广告状态 |
| 9 | `inbox` | Inbox 列表摘要 |

## 3. 读取完整数据

这里的“完整”指**指定批次中允许对外提供的全部有效保存记录**。接口不会补采未保存的详情，也不提供原始 JSON 下载。

### 第一步：选择批次

```http
GET /api/crm/v1/stores/{storeKey}/checks/{checkId}/runs?from=2026-09-01&to=2026-09-12&page=1&pageSize=100
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `from`、`to` | 否 | 起止日期，含两端；按结果的北京时间采集日期筛选，**不是评价发表日期** |
| `page` | 否 | 从 1 开始，默认 1，最大 1,000,000 |
| `pageSize` | 否 | 默认 100，最大 200 |

`data` 按报告时间由新到旧返回。选中批次后，保留它的 `runId` 和 `snapshotId`，用于下一步。

批次里的三个数量含义不同：`matchingResultCount` 是日期筛选命中的结果数，`resultCount` 是该店整个批次的结果数，`savedRecordCount` 是展开后的 API 记录数，包含摘要行。

**日期条件只用于选批次。** 一个批次有结果命中就会入选；随后读取 `data` 时，返回该店的整个批次，不再沿用 `from/to` 筛选。

### 第二步：固定批次，逐页读取

```http
GET /api/crm/v1/stores/{storeKey}/checks/{checkId}/data?runId=RUN_ID&snapshotId=SNAPSHOT_ID&page=1&pageSize=100
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `runId` | 是 | 从 `runs` 返回值中取得，原样传回，不自行构造 |
| `snapshotId` | 否，建议始终传入 | 报告内容摘要；用于发现翻页期间的数据变化 |
| `page`、`pageSize` | 否 | 与 `runs` 使用相同的默认值和范围 |

沿用前面的 `read` 函数和 `base`，下面的示例读取最新 Reviews 批次的所有页面：

```js
const runs = await read(base + '/checks/reviews/runs?page=1&pageSize=100');
const latestRun = runs.data[0];

if (latestRun) {
  const { runId, snapshotId } = latestRun;
  const records = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      runId, snapshotId, page: String(page), pageSize: '100',
    });
    const response = await read(base + '/checks/reviews/data?' + query);
    records.push(...response.data);
    if (!response.pagination.hasMore) break;
  }
  // 全部分页成功后，再将 records 交给 CRM 的展示或后续业务处理。
}
```

翻页时保持 `runId/snapshotId/pageSize` 不变。`pagination` 返回 `page/pageSize/total/pages/hasMore`；超过末页时返回空数组。

- 遇到 `409 SNAPSHOT_CHANGED`，丢弃已经拼接的页面，重新查询批次，从第一页开始。
- 遇到 `409 REPORT_CONFLICT`，表示同一 `runId` 的保存副本不一致，交给监测站维护人员核对。
- 旧报告可能返回 `legacy:` 或 `opaque:` 开头的 `runId`。把它当普通标识原样传回即可。

所有接口都会拒绝未知或重复的 query 参数。`stores/results` 不接受 query；`runs` 只接受 `from/to/page/pageSize`，`data` 只接受 `runId/snapshotId/page/pageSize`。路径段使用 URL 编码，query 用 `URLSearchParams` 构造；不要把 token、ticket 或密码放入 query。

### 明细记录的结构

`data.data` 是记录数组。每条都有 `recordType`、`resultIndex` 和所属检查结果 `result`，再按类型提供明细：

| recordType | 内容 |
|---|---|
| `check-result` | 没有明细的检查结果；Inbox 只返回这种摘要 |
| `business-item` | 一般业务明细，另有 `itemIndex` 和 `item` |
| `voc-asin` | VOC 的 ASIN 概况 |
| `voc-record` | 该 ASIN 下的单条 VOC 记录，另有 `recordIndex` 和 `parentAsin`；每条记录独立参与分页 |

返回顺序沿用保存的 result/item 顺序，VOC 按 ASIN 概况及其记录展开。索引从 0 开始，只在当前批次内有效。跨批次关联时，应使用实际存在的 `reviewId/orderId/asin/sku` 等业务标识，不要用数组序号去重。

### 能拿到什么，哪些情况会缺数据

公开字段包括 ASIN/SKU、评分、评价日期、业务文本、订单/退货标识、VOC 指标、广告名称和状态等，具体字段以 OpenAPI 为准。未知数值保留 `null`。

| 情况 | 接口行为 |
|---|---|
| 报告损坏、结构无效或时间明显在未来 | 排除该报告，并计入 `metadata.ignoredReports`；该计数覆盖所读检查目录，不是本店专属计数 |
| Inbox | 仅返回检查摘要，不返回主题、正文、买家、订单或消息 ID |
| Reviews 历史截图关联缺失 | `reviewPages` 返回空数组；只有保存页的 `reviewIds` 明确关联当前评价时，才返回页码和截图采集时间，不推测关联或更改评价日期 |
| 凭据、结构化买家身份及联系字段、原始 DOM/页面文本、内部路径、截图 | 不通过接口提供 |

允许返回的业务自由文本会移除已识别的身份值，并按现有规则脱敏。无标签的自然语言仍可能含有未识别的个人信息，请勿用这些文本建立个人资料。

## 4. 错误处理和调用频率

错误响应使用 `application/problem+json`（[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)），不放在成功响应的 `data` 中。例如：

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "code": "SNAPSHOT_CHANGED",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "detail": "The saved run changed; restart pagination.",
  "instance": "/api/crm/v1/stores/US-DEMO/checks/reviews/data"
}
```

| HTTP | CRM 侧怎么处理 |
|---|---|
| 400 | 修正参数、JSON 或 HTTPS 请求条件，不原样重试 |
| 401 | 后端核对 Bearer；浏览器会话失效时，从 CRM 重新进入 |
| 403 | 核对店铺权限、跳转目的地或同源校验 |
| 404 | 核对店铺授权、checkId 和 runId；不能把“取不到数据”显示为正常 |
| 405 | 改用 `Allow` 响应头指定的方法 |
| 409 | 根据 `code` 处理；快照和报告冲突见上节，免密握手已签发时不要重复签票 |
| 413 / 415 | 修正正文大小、Content-Type 或压缩方式 |
| 421 | 使用本文开头的规范服务域名 |
| 429 | 等待 `Retry-After` 指定的秒数后重试 |
| 500 / 503 | 显示暂时不可用，记录 `requestId` 交给维护人员；503 也可能是免密回调尚未配置 |

限流按可信客户端 IP 计算，窗口为 60 秒：

| 范围 | 上限 |
|---|---|
| API 请求合计 | 120 次 |
| 浏览器 `/crm` 路径请求合计 | 60 次 |
| 开始免密握手 | 另限 10 次 |
| 签票、兑换 | 各另限 20 次 |

多个用户共用出口时会共享额度。响应头 `X-RateLimit-Limit/Remaining` 给出额度信息；请求命中多项规则时，头部显示最后检查的一项，其他限制仍然有效。读取请求可退避重试；签票超时或响应丢失时，从 CRM 重新开始握手。

排查问题只需提供 `requestId`、错误码和发生时间，不要附带令牌、Cookie 或原始业务数据。

## 5. 免密跳转（可选）

这一部分用于在 CRM 添加“打开监测详情”按钮。只做后端取数时可以跳过。

**接入前先由 CRM 实现一个固定的 HTTPS 回调地址，并交给监测站运维配置。** 回调未配置时，能力接口返回 `ssoAvailable=false`，开始跳转返回 503。已有的 HTTP CRM 页面地址不能直接作为此回调。

### 按钮链接

使用普通顶层链接，不嵌入 iframe，也不在链接里放认证令牌：

```text
https://amzcheck.pc51.com/crm/sso/start?storeKey=US-DEMO&view=results
https://amzcheck.pc51.com/crm/sso/start?storeKey=US-DEMO&checkId=reviews&view=data
```

`storeKey/view` 必填，`view` 可取 `results` 或 `data`，`checkId` 可省略。`checkId/view` 只决定打开后的初始页面，会话有权读取该店全部九项检查。

### CRM 后端需要做的事

1. 用户点击按钮后，监测站建立握手，并通过 303 跳回已配置的 CRM HTTPS 回调，带上 `challengeId/storeKey/view` 和可选的 `checkId`。
2. CRM 回调检查当前用户是否已登录、是否有该店铺的读取权限。回调参数只说明用户要去哪里，不能当作授权依据。
3. 校验通过后，CRM 后端携带专用 Bearer，调用 `POST /api/crm/v1/sso/tickets` 签票。`storeKey/checkId/view` 必须与收到的握手目的地完全一致。
4. 监测站返回 201。CRM 后端将当前浏览器 303 跳转到 `data.loginUrl`；后续兑换和进入只读页面由监测站完成，CRM 无需自行兑换。

签票正文：

```json
{
  "challengeId": "<FROM_MONITOR_CALLBACK_QUERY>",
  "subject": "crm-user-demo",
  "storeKey": "US-DEMO",
  "checkId": "reviews",
  "view": "data"
}
```

`subject` 使用 CRM 内部稳定、不含个人信息的用户标识，长度 1–128 字符，不含首尾空白或控制字符。POST 使用 `Content-Type: application/json`，正文不超过 8192 字节，不接受压缩正文或未知字段。

### 有效期与会话规则

| 项目 | 规则 |
|---|---|
| 握手 | 120 秒，绑定发起它的浏览器，通过独立 HttpOnly Cookie 校验 |
| 票据 | 一次有效，最长 60 秒，且不能超过握手期限；跨浏览器或重复兑换会被拒绝 |
| 只读会话 | 30 分钟，不自动续期，只授权一家店铺；失效后从 CRM 重新进入 |
| 重启或 CRM 入站认证配置变化 | 内存中的握手、票据和会话失效；修改店铺展示名或页面设置不会清空会话。当前实现为单进程，不能任意分发到多个实例 |

`loginUrl` 固定指向监测站的 `/crm/sso#ticket=...`。CRM 不要记录这个值或拼接任意 `returnUrl`。监测站完成页会先清除 fragment，再同源 POST 兑换票据。

浏览器使用独立的只读 Cookie，不能调用原 Dashboard API；普通 Dashboard Cookie 也不能读取 CRM 接口。取数 API 同时收到 Authorization 和 Cookie 时，以 Authorization 为准，错误 Bearer 不会回退到 Cookie。`/crm`、`/crm/` 和 `/crm/session` 只认 CRM Cookie。Bearer 使用 HTTPS 请求头传递（[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)）；这里的免密握手是本项目协议，不是 OAuth/OIDC。

`/crm/session`、`/crm/sso/exchange` 和 `/crm/logout` 由监测站页面调用。兑换和退出要求匹配的 Origin 与同源 JSON；退出发送 POST `{}`，只撤销 CRM 只读会话。

## 6. 监测站配置

本节由监测站运维处理。变量写入 `/etc/amzguard/dashboard.env`，文件权限保持 `root:root 0600`，无需改动 `channels.env`。

| 变量 | 填什么 |
|---|---|
| `AMZGUARD_CRM_CLIENT_ID` | 客户端标识；字母数字开头，后续允许 `._-`，最长 64 字符 |
| `AMZGUARD_CRM_API_TOKEN` | 新生成的后端专用随机令牌，32–512 字符 |
| `AMZGUARD_CRM_STORE_KEYS` | 允许读取的确切店铺 key，逗号分隔、不重复，不支持 `*`；每个 key 与客户端标识使用相同字符规则 |
| `AMZGUARD_CRM_PUBLIC_ORIGIN` | `https://amzcheck.pc51.com` 这样的 HTTPS origin；不含路径、query、fragment、用户名或密码 |
| `AMZGUARD_CRM_CALLBACK_URL` | CRM 已实现的固定 HTTPS 回调 URL；不含 query、fragment、用户名或密码。暂不接免密时留空 |

五项全空表示关闭；启用时前四项必须配齐，部分配置无效会拒绝启动。回调留空不影响后端取数。

在现有 env 文件中补充配置，修改后重启 Dashboard，再核对能力接口和授权店铺列表。不要重跑初始化器覆盖生产文件，也无需启动巡检或通知。发布与回滚见 [部署说明](../DEPLOY.md)。

管理员在 `/#stores` 维护的启用店铺，与 `AMZGUARD_CRM_STORE_KEYS` 共同决定可读范围：**只有同时出现在两份名单中的店铺才可读取。** 新店需由运维加入授权，再由 CRM 开发者建立映射。管理文件损坏时拒绝服务，不回退到旧名单。存储位置和管理接口见[店铺与页面配置](OPERATIONS.md#店铺与页面配置)；CRM 凭据不能修改这些配置。

### 现有 CRM 的对接备注

2026-09-12 曾只读核对已登录的 SellerMaking 页面（入口 `http://amzcrm.pc51.com/analysis/dashboard`）：其前端使用 `/api` 前缀和 Bearer 认证；GET `/api/auth/me` 返回 `code/msg/data`，用户字段有 `id/username/name/role/seller_id/permissions`；GET `/api/shops` 返回列表 `data` 和数量 `count`。当时未核实可用的 HTTPS 免密回调。

这些记录仅供 CRM 开发者定位现有用户与店铺逻辑，不作为 CRM 的稳定接口契约。页面还存在 POST 查询和设置保存逻辑，不能按方法名判断副作用；该次核对未调用新增、编辑、删除、同步或导入接口。原有出站导出与推送另见 [CRM 兼容导出](CRM_EXPORT_COMPATIBILITY.md)。

联调时，用正式获准的 CRM 用户核对取数、越权拒绝、会话失效后重进和退出。`npm test` 可验证监测站的离线行为，但不能证明 CRM 已安装按钮或回调已上线，也不能证明 Amazon 数据刚刚更新。
