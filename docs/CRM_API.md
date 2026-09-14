# CRM 店铺监测 API 接入说明

这份说明供 CRM 开发者接入店铺监测。拿到本文、同目录的 `crm-openapi.json` 和单独交付的 API Token 后，就可以开始开发；无需安装监测站程序或 Node.js。

| 接入信息 | 值 |
|---|---|
| 服务地址 | `https://amzcheck.pc51.com` |
| API 前缀 / 响应版本 | `/api/crm/v1` / `1.0` |
| 后端认证 | `Authorization: Bearer <API_TOKEN>` |
| 当前 CRM 来源 | `http://amzcrm.pc51.com` |
| 当前免密方式 | 弹窗 `popup`，入口 `/crm/sso/bridge` |
| 当前授权店铺 key | `XCAI`、`LUPING`、`JUNJUN`、`chen-rui`、`FENG`、`WANG` |

以上接入状态于 **2026-09-12** 核对。开发时通过能力和店铺接口读取最新配置，不把这份名单写死在页面中。重定向方式的 HTTPS 回调目前未配置，不要使用 `/crm/sso/start` 作为现有 CRM 的入口。

本期提供两类数据：**`results` 是检查结论，`data` 是某次检查保存的明细**。读取不会触发 Amazon 采集，也不会向 CRM 写入业务数据；不包含竞品情报、补跑、上传或店铺管理接口。

先完成第 1～4 节的后端取数，再按第 5 节接“查看监测详情”按钮。完整字段、类型和错误码查阅 [OpenAPI 规范](crm-openapi.json)；也可带 Token 请求 `GET /api/crm/v1/openapi.json` 获取线上版本。

## 1. 先接通一个店铺

### Token 与店铺映射

API Token 只放在 CRM 后端环境变量或密钥管理系统中，不下发网页，也不放进 URL、源码或日志。它与 CRM 用户登录 Token、监测站管理员密码均不通用。

先调用：

| 请求 | 用途 |
|---|---|
| `GET /api/crm/v1` | 读取授权店铺、九项检查目录 `data.checks`、过期阈值和 `ssoModes` |
| `GET /api/crm/v1/stores` | 读取店铺数组，每店有 `storeKey`、`storeName`、`market` |

CRM 内部店铺 ID 与监测站的 `storeKey` 是两套标识，需建立明确映射，不能直接互换或仅凭展示名称匹配。每次向 CRM 用户提供某店数据前，CRM 后端都要检查该用户的店铺权限。免密面板不需要店铺映射，按第 5 节检查面板访问权限。

接口只返回当前 Token 获准访问且已启用的店铺。新增店铺需另行授权；停用后不可读取；改展示名称不改变 `storeKey`。

### 第一个请求

将单独交付的 Token 配入 CRM 后端环境变量 `AMZGUARD_CRM_API_TOKEN` 后，可在该服务器验证：

```bash
curl -sS -i --max-time 15 \
  -H "Authorization: Bearer $AMZGUARD_CRM_API_TOKEN" \
  -H 'Accept: application/json' \
  'https://amzcheck.pc51.com/api/crm/v1/stores'
```

PHP / Laravel 使用同样的 HTTPS 请求头即可。**按 HTTP 状态判断成功，不按 CRM 原有的 `code === 0` 判断。** 本接口没有开放 CORS，由 CRM 后端取数，再通过 CRM 自己的接口提供给前端。

### 响应怎么读

成功 JSON 都有 `apiVersion`、`requestId`、`generatedAt`、`data`；错误格式见第 4 节。OpenAPI 文件、HTML 和重定向不使用这个 JSON 包装。

| 字段 | 含义 |
|---|---|
| `data` | 业务内容；结果接口返回对象，店铺、批次和明细接口返回数组 |
| `generatedAt` | API 响应生成时间，不是 Amazon 采集时间 |
| `pagination` | 分页信息；不分页的数据接口返回 `null` |
| `metadata.staleAfterMs` | 数据过期阈值，单位毫秒 |
| `metadata.ignoredReports` | 本次读取的检查目录中被排除的无效报告数，并非仅统计本店；大于 0 时提示数据覆盖不完整 |
| `requestId` | 请求编号，也在 `X-Request-Id` 响应头中，供排查问题使用 |

能力、票据、会话和退出接口不带 `pagination/metadata`。响应带 `Cache-Control: no-store`；缺失值保留 `null`，不能转成 0 或“正常”。采集时间采用 ISO 8601，日期筛选使用北京时间的 `YYYY-MM-DD`。

## 2. 读取探测结果

```http
GET /api/crm/v1/stores/{storeKey}/results
```

不接受 query 参数。返回的 `data.store` 是店铺信息，`data.checks` 固定包含九项检查：

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

页面选项建议使用能力接口的 `data.checks`（`id/no/title/scope`）。编号是历史标识，不代表展示顺序。

| 位置 | 重点字段 |
|---|---|
| 每个 check | `checkId/checkNo/title`：标识与名称；`status`：**状态数组**；`severity/stale`：严重程度与新鲜度；`resultCount/results`：数量与逐条结果 |
| 每条 result | `status`：**状态字符串**；`severity/ok/actionState`：展示依据；`businessStatus/collectionStatus/confidence`：业务状态、采集状态与可信度 |
| 每条 result 的其他内容 | `metrics`：检查指标；`source`：批次与采集时间；`evidence`：DOM 和页面文本的证据可用性 |

`actionState` 为 `NORMAL`（正常）、`BUSINESS`（业务需处理）或 `COLLECTION`（采集需处理）。不要只靠一个计数显示绿色，以下情况要保留提示：

- **暂无结果**：`status: ["NEVER_RUN"]`、`severity: null`、`results: []`。可能未采集，也可能已有报告被排除，不能直接显示“正常”。
- **证据不足**：`UNKNOWN`、`PARTIAL_EVIDENCE`、未识别状态、双路冲突都需提醒；`ERROR` 不等于已确认业务违规。`evidence.dom/text.available` 只表示证据对象非空且未标记 error，两路可用也不证明分页完整。
- **数据过期**：显示 `source.collectedAt` 和 `stale`，结合 `timeSource/timestampValid` 判断时间来源。当前默认阈值为 36 小时，最低可配置 1 小时，以接口返回值为准。
- **历史状态矛盾**：接口会保守调整展示用的 `severity/ok/actionState`，并标记 `presentationAdjusted`；`recordedSeverity/recordedOk` 保留历史原值，不改写保存文件。

最新结果可能合并不同批次，例如只补跑一个 ASIN 后，其他 ASIN 仍沿用原采集时间。缺少 `checkedAt` 时，依次取报告结束、开始、接收时间，最后取文件 mtime；`timeSource` 会说明来源，mtime 不能证明采集时间。刷新 CRM 页面只会重读保存数据，不会提高 Amazon 采样频率。

## 3. 读取完整数据

“完整”指指定批次中允许对外提供的全部有效保存记录，不代表 Amazon 当前的全部数据。接口不会补采缺失详情，也不提供原始 JSON 或截图下载。

### 先选批次，再逐页读取

```http
GET /api/crm/v1/stores/{storeKey}/checks/{checkId}/runs?from=2026-09-01&to=2026-09-12&page=1&pageSize=100
GET /api/crm/v1/stores/{storeKey}/checks/{checkId}/data?runId={runId}&snapshotId={snapshotId}&page=1&pageSize=100
```

| 参数 | 适用接口 | 规则 |
|---|---|---|
| `from/to` | `runs` | 可选，含起止日期，按结果的北京时间采集日期筛选，不是评价发表日期；`from` 不得晚于 `to` |
| `runId` | `data` | 必填，从 `runs` 原样取得，包括旧数据的 `legacy:`、`opaque:` 标识 |
| `snapshotId` | `data` | 可选，但建议始终传入；从 `runs` 原样取得，用于发现翻页期间的数据变化 |
| `page` | 两者 | 默认 1，最大 1,000,000；只接受无前导零的正整数 |
| `pageSize` | 两者 | 默认 100，最大 200；只接受无前导零的正整数 |

读取步骤：

1. `runs.data` 按报告时间由新到旧排列，选中批次并保存 `runId/snapshotId`。
2. `data` 从第 1 页开始读取。翻页只增加 `page`，保持 `runId/snapshotId/pageSize` 不变。
3. 将响应的 `data` 数组依次拼接，直到 `pagination.hasMore=false`；全部成功后再使用这批记录。`pagination` 还含 `total/pages`，超过末页返回空数组。
4. 遇到 `409 SNAPSHOT_CHANGED`，丢弃已拼接的页面，重新选批次并从第 1 页开始；`409 REPORT_CONFLICT` 表示同一批次的保存副本冲突，交给监测站维护人员处理。

日期条件只用来选择批次：一个批次有结果命中就会入选，随后 `data` 返回该店整个批次。`matchingResultCount` 是日期命中的结果数，`resultCount` 是该店批次的结果数，`savedRecordCount` 是展开后的 API 记录数（含摘要行）。

未知或重复的 query 参数会被拒绝。`stores/results` 不接受 query；`runs` 仅接受 `from/to/page/pageSize`；`data` 仅接受 `runId/snapshotId/page/pageSize`。用标准 URL 编码构造路径段和 query，不自行拼接未经编码的值。

### 明细内容与边界

响应正文的 `data` 是记录数组。每条都有 `recordType/resultIndex/result`，按类型提供内容：

| recordType | 内容 |
|---|---|
| `check-result` | 检查摘要，无明细；Inbox 仅返回这一类 |
| `business-item` | 一般业务明细，含 `itemIndex/item` |
| `voc-asin` | VOC 的 ASIN 概况 |
| `voc-record` | 该 ASIN 的单条 VOC 记录，含 `recordIndex/parentAsin`，每条独立参与分页 |

记录沿用保存顺序，VOC 按 ASIN 概况及其记录展开。索引从 0 开始，仅在当前批次有效；跨批次关联使用实际存在的 `reviewId/orderId/asin/sku` 等业务标识。字段类型、可空值和历史日期格式以 OpenAPI 为准。

- 报告损坏、结构无效或时间明显在未来时会被排除，计入 `metadata.ignoredReports`。
- Inbox 不返回消息主题、正文、买家、订单或消息 ID。其他接口也不提供凭据、结构化买家身份/联系字段、原始 DOM/页面文本、内部路径或截图。
- Reviews 只有保存页的 `reviewIds` 明确关联当前评价时，才返回 `reviewPages` 中的页码与截图采集时间；历史关联缺失时为空数组，不推测关联或更改评价日期。
- 业务自由文本会按现有规则脱敏，但无标签的自然语言仍可能含未识别的个人信息，不应据此建立个人资料。

## 4. 错误处理和调用频率

错误使用 `application/problem+json`（RFC 9457），与成功响应分开：

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "code": "SNAPSHOT_CHANGED",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "detail": "The saved run changed; restart pagination.",
  "instance": "/api/crm/v1/stores/XCAI/checks/reviews/data"
}
```

| HTTP 状态 | 处理方式 |
|---|---|
| 400 | 检查参数、JSON 和 HTTPS 条件，不原样重试 |
| 401 | 检查后端 Token；浏览器会话过期时，从 CRM 重新进入 |
| 403 / 404 | 检查店铺权限、检查标识、批次或跳转目的地；取不到数据不能显示为正常 |
| 405 | 使用 `Allow` 响应头指定的方法 |
| 409 | 按 `code` 处理快照变化、报告冲突或握手已签票；不要重复签票 |
| 413 / 415 | 修正正文大小、Content-Type 或压缩方式 |
| 421 | 使用本文的规范服务地址 |
| 429 | 读取请求等待 `Retry-After` 指定秒数后重试；签票/兑换重新开始握手 |
| 500 / 503 | 显示暂时不可用，保留 `requestId` 交给维护人员；503 也可能是相应免密模式未配置 |

按可信客户端 IP 限流，每个窗口 60 秒：API 合计 **120 次**，浏览器 `/crm` 路径合计 **60 次**；开始握手另限 **10 次**，签票和兑换各另限 **20 次**。共用出口的用户共享额度。`X-RateLimit-Limit/Remaining` 显示最后检查的一项额度，其他限制仍有效。

读取请求可退避重试；**签票和兑换不要自动重试**。排查时只提供请求编号、错误码和时间，不附 Token、Cookie 或业务原文。

## 5. 免密跳转（可选）

当前 CRM 使用 HTTP 页面和 Bearer 登录，请接入**弹窗模式**。默认进入我们的巡检面板，可切换查看全部已启用店铺，无需传店铺或建立店铺映射。CRM 后端负责确认当前用户有权查看整个巡检面板，监测站负责一次性票据和只读会话。后端取数不依赖免密功能。

### 第一步：CRM 页面打开监测窗口

先注册 `message` 监听，再在用户点击时同步 `window.open`，不要先等待异步请求。每次打开生成一个 32 字节随机数，编码为 43 字符 base64url，作为 `requestId`。HTTP 页面可用 `crypto.getRandomValues`，不要依赖仅安全上下文可用的 `crypto.randomUUID`。

```http
GET /crm/sso/bridge?requestId={requestId}
```

只需 `requestId`。省略 `storeKey/view/checkId` 即进入面板；也可显式传 `view=dashboard`。不能把无效或空字符串店铺 key 当作默认入口。

不要设置会切断 opener 的 `noopener/noreferrer`，不要嵌入 iframe。页面或代理的 `Cross-Origin-Opener-Policy: same-origin` 也可能切断窗口关系，接入页需使用可保留弹窗关系的策略。

### 第二步：接收握手，交给 CRM 后端签票

监测窗口设置 Secure、HttpOnly 绑定 Cookie，并只向已配置的 CRM origin 发送一次消息：

```json
{
  "type": "amzguard:crm:challenge",
  "version": 1,
  "requestId": "<本次打开生成的 requestId>",
  "challengeId": "<监测站生成的 challengeId>",
  "storeKey": null,
  "view": "dashboard",
  "checkId": null
}
```

CRM 页面须核对 `event.origin === 'https://amzcheck.pc51.com'`、`event.source` 是本次窗口、`version === 1`，并核对本次 `requestId`、`view === 'dashboard'`、`storeKey === null`、`checkId === null`。记录这次 `challengeId` 后，仅处理一次握手，再通过 CRM 自己的已认证请求链路调用后端。

CRM 后端独立检查当前用户已登录、有权查看全部店铺的巡检面板，再携带专用 API Token 签票：

```http
POST /api/crm/v1/sso/tickets
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

```json
{
  "challengeId": "<收到的 challengeId>",
  "subject": "crm-user-123"
}
```

默认面板签票只需 `challengeId` 与 `subject` 两个字段；不要转发前端提交的店铺、角色或跳转地址。`subject` 由 CRM 后端从真实用户身份生成，使用稳定、不含个人信息的用户标识，长度 1～128 字符，无首尾空白或控制字符；不要信任前端提交的用户身份或角色。正文最多 8192 字节，不接受压缩或未知字段。

成功返回 **201**，正文的 `data` 含 `loginUrl/expiresAt/singleUse`。保留原样 `loginUrl`，不要拼接任意跳转地址。当前 CRM 的请求封装会重试部分失败，签票这一请求须关闭自动重试。

### 第三步：把票据交回原窗口

CRM 页面向原监测窗口的精确 origin `https://amzcheck.pc51.com` 发送：

```json
{
  "type": "amzguard:crm:ticket",
  "version": 1,
  "requestId": "<本次 requestId>",
  "challengeId": "<本次 challengeId>",
  "loginUrl": "<签票响应中的 data.loginUrl>"
}
```

监测窗口校验来源、窗口、关联值和固定登录地址，在 HTTPS 同源兑换票据。成功后发送 `{type:'amzguard:crm:complete',version:1,requestId,challengeId}`，断开 opener 并进入 `/crm/`。CRM 收到完成消息时仍要核对来源、窗口和本次关联值；签票返回成功本身不等于浏览器已登录。

CRM 鉴权或签票失败时，发送 `{type:'amzguard:crm:error',version:1,requestId,challengeId}` 结束握手，或关闭窗口。消息使用上述精确字段，不附加身份、原始错误或凭据，不使用 `*` 作为目标 origin。监测窗口会忽略错误来源、窗口或关联值，重复票据不会再次兑换。

### 会话与失败处理

| 项目 | 规则 |
|---|---|
| 握手 | 120 秒，绑定发起浏览器；同一浏览器一次完成一个握手，同时打开多个窗口可能使较早绑定失效 |
| 票据 | 一次有效，最长 60 秒且不超过握手期限；跨浏览器和重放均拒绝 |
| 只读会话 | 30 分钟，不自动续期；默认可查看全部已启用店铺的巡检面板，过期后从 CRM 重新进入 |
| 关闭窗口、超时或响应丢失 | 由用户重新发起握手，不自动重试签票或兑换 |
| CRM 退出/撤销用户权限 | 不会主动撤销已发出的监测会话，最长保留至其 30 分钟到期；监测站停用店铺后面板不再展示该店；新增并启用店铺会自动出现在面板中 |
| 监测站重启/修改入站认证配置 | 握手、票据和会话失效；改展示名/页面设置不会清空会话。当前认证状态为单进程内存，不能任意分发到多个实例 |

API Token 不进入窗口消息；CRM 用户 Token 留在 CRM 原有请求链路，不交给监测站。`loginUrl` 固定为 `https://amzcheck.pc51.com/crm/sso#ticket=...`，不记录票据。HTTP CRM 页面及原有登录请求仍受 HTTP 传输限制，监测站 API 和兑换始终要求 HTTPS。

监测页自行调用 `/crm/session`、`/crm/sso/exchange`、`/crm/logout`；兑换和退出使用同源 JSON POST，退出正文为 `{}`。面板复用现有界面，显示巡检总览、店铺风险、客户声音、商品状态、广告值守和系统保障，可查看已保存明细、历史及关联截图。不能管理店铺/用户、修改广告规则、上传、补跑或查看竞品情报。页面通过独立的 `/crm/dashboard/` 只读路径加载数据，不取得 Dashboard 账户角色。此内部路径由页面自行调用，CRM 后端取数仍使用第 1～4 节的 API。面板请求按 IP 每分钟最多 180 次；刷新仅读取已保存数据。面板会话不能用来调用机器数据 API；API Token 的店铺白名单仍保持原范围。旧单店会话的数据 API 同时收到 Authorization 和 Cookie 时，以 Authorization 为准，错误 Bearer 不回退到 Cookie；`/crm`、`/crm/`、`/crm/session` 只认独立 CRM Cookie。此握手是本项目协议，不是 OAuth/OIDC。

### 以后需要 HTTPS 重定向时

仅在 CRM 已有可识别当前用户的 HTTPS 回调时使用：监测站配置固定回调，CRM 链接进入 `/crm/sso/start`，监测站通过 303 带回 `challengeId/view=dashboard`。CRM 回调鉴权后调用同一个签票接口，再将浏览器 303 跳到 `data.loginUrl`；监测完成页先清除 fragment，再同源兑换。

HTTP 页面的 localStorage Token 不会随导航自动带给 HTTPS 回调。回调须有有效域名证书，不能用普通页面地址代替，也不关闭 TLS 校验。未配置时该入口返回 503，不会自动切换到弹窗。现有 Node.js 22+ 回调参考组件不属于 Laravel CRM 的接入依赖。

### 旧单店链接兼容

旧入口仍可传 `storeKey=XCAI&view=results`（或 `data`），并可带 `checkId`；签票时须原样传回这三个字段。此时仍是原来的单店只读页，受 API Token 的店铺白名单限制，不能进入全部店铺面板。新接入直接使用上面的默认方式即可。

## 6. 监测站配置

本节供监测站运维维护，**CRM 开发者接入当前服务无需配置这些变量**。配置位于 `/etc/amzguard/dashboard.env`，保持 `root:root 0600`。

| 变量 | 约束 |
|---|---|
| `AMZGUARD_CRM_CLIENT_ID` | 客户端标识，字母数字开头，后续允许 `._-`，最长 64 字符 |
| `AMZGUARD_CRM_API_TOKEN` | 后端专用随机令牌，32～512 字符，与其他凭据独立 |
| `AMZGUARD_CRM_STORE_KEYS` | 逗号分隔的确切店铺 key，不重复、不支持 `*`，每个 key 与客户端标识使用相同字符规则 |
| `AMZGUARD_CRM_PUBLIC_ORIGIN` | 规范 HTTPS origin，不含路径、query、fragment、用户名或密码 |
| `AMZGUARD_CRM_CALLBACK_URL` | 重定向模式的固定 HTTPS 回调，不含 query、fragment、用户名或密码；仅用弹窗时留空 |
| `AMZGUARD_CRM_BRIDGE_ORIGIN` | 弹窗唯一允许的 HTTP/HTTPS 来源，使用 `URL.origin` 规范值；不得等于监测站 origin，不含路径、尾斜杠、query、fragment、用户名或密码，不接受 `*`；默认留空关闭 |

六项全空为关闭，启用时前四项必须配齐，部分配置无效会拒绝启动。后两项分别启用重定向和弹窗，都留空仍可后端取数。`ssoModes` 表示已配置模式，旧版本可能没有此字段；`ssoAvailable=true` 不代表 CRM 已完成接入。

机器数据 API 和旧单店免密的可读店铺必须同时在管理员维护的启用名单和 Token 授权名单中；新增店铺不自动扩大这两类授权。默认免密面板独立展示全部已启用店铺，无需维护店铺白名单；管理文件损坏时拒绝服务，不回退旧名单。修改 env 后重启 Dashboard 并核对能力、店铺接口；保留现有 env、运行数据和定时器状态，不重跑初始化器，也不启动巡检或通知。入站配置与出站 `CRM_ENDPOINT/CRM_TOKEN` 独立，不改动 `channels.env`。

当前 CRM 只读核对结果为 Vue 3.5.34、Vue Router 4.6.4、Pinia 2.3.1、Element Plus 2.14.0、Vite 构建和 PHP / Laravel；PHP、Laravel 准确版本未公开。接口使用标准 HTTPS、Bearer 和 JSON，不要求特定 SDK。交付的是监测站接口，CRM 的按钮和用户权限逻辑由 CRM 开发者完成；上线前用真实获准用户核对取数、越权拒绝、过期重进与退出。离线测试通过不代表 CRM 已完成联调，也不代表 Amazon 数据刚更新。
