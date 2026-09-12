/** Operator learning content. The tour only navigates dashboard views. */
export const OPERATOR_LESSONS = [
  {
    id: 'overview', chapter: '认识工作台', label: '每天从这里开始', view: 'overview', target: '.hero',
    title: '先回答：今天哪些店铺需要我？',
    intro: '平台把多店铺的九项巡检汇总成运营待办。你负责判断与跟进业务，系统负责定时采集、保留证据和提醒。',
    cards: [
      ['先看运营待处理', '从总览的业务事项数量开始，再进入对应业务页面，找到具体店铺和检查项。'],
      ['再看技术待修复与未完成', '采集失败、证据不足或尚未运行，都不能当作店铺正常；交给对应负责人核验。'],
      ['确认信息够新', '页面“最近同步”是看板刷新时间。判断业务时，还要看检查详情里的“最近运行”和批次。'],
    ],
    takeaway: '九项巡检只读采集。业务处理通常要由你进入对应店铺的紫鸟后台完成，再等下一轮复检。',
  },
  {
    id: 'states', chapter: '认识工作台', label: '读懂颜色与归口', view: 'store-risk', target: '#riskMatrix .legend',
    title: '同样是提醒，下一步可能完全不同',
    intro: '先识别状态，再决定交给谁。颜色之外，每个方框也有文字标签。',
    kind: 'states',
    cards: [
      ['绿 · 正常', '当前有效证据显示无需处理，仍需留意采集时间。'],
      ['黄 / 红 · 业务关注或异常', '由运营检查低星、绩效风险、广告时段等具体原因，并安排处理。'],
      ['紫 · 采集异常', '由技术排查登录、页面或证据问题；真实业务状态仍待确认。'],
      ['灰 · 未完成', '查看排程、覆盖范围或配置原因，不能把空白当成正常。'],
    ],
    quiz: { question: '练习：店铺显示“采集异常”，你应该怎么做？', options: ['先按正常店铺放过', '带店铺、时间和错误证据交给技术'], correct: 1, explanation: '对。采集异常说明证据不可靠，先修复采集，再判断业务。' },
  },
  {
    id: 'progress', chapter: '认识工作台', label: '确认巡检是否在运行', view: 'overview', target: '.execution-panel',
    title: '进度到 100%，代表这一轮执行结束',
    intro: '执行进度与业务结论分别显示。完成一轮后，仍可能有运营事项或采集异常。',
    cards: [
      ['看总进度', '这里显示本轮百分比、正在检查的店铺与项目、运行时长；按本轮纳入的检查范围计数。'],
      ['看店铺小方框', '转圈表示正在采集，静态圈表示等待；采集期间标有“上次”的结果属于历史记录。ASIN 检查还显示已完成商品数。'],
      ['发现延迟怎么办', '进度每 2 秒同步。出现连接中断、心跳延迟或任务中断时，记录店铺与时间交给技术，不把转圈当成业务正常。'],
    ],
    takeaway: '100% 是执行完成；是否需要你处理，要继续看运营和技术待办。',
  },
  {
    id: 'risk', chapter: '处理运营事项', label: '账户健康与绩效', view: 'store-risk', target: '#riskMatrix', checks: ['store-health', 'performance'],
    title: '先排查可能影响店铺经营的风险',
    intro: '“店铺风险”聚合账户健康和绩效两项检查，下面的行动队列列出具体待办。',
    cards: [
      ['01 · 店铺健康', '只有 Policy Compliance 为 Healthy 才正常。不要只看账户评分较高，就忽略合规风险。'],
      ['02 · 绩效', '留意未处理事项和明显标红提示。Amazon 页面上的风险仍存在时，会持续提醒。'],
      ['找到自己的店铺', '在搜索框输入店铺名，再选择“运营要处理”；点击小方框或行动队列查看原因。没有搜索结果时，先检查筛选条件。'],
    ],
    takeaway: '进入对应店铺的紫鸟后台处理后，复查下一轮证据。平台没有“点一下就消除 Amazon 风险”的操作。',
  },
  {
    id: 'evidence', chapter: '处理运营事项', label: '读一条检查证据', view: 'store-risk', target: '#riskMatrix .matrix-wrap',
    title: '处理前，先核对店铺、时间和原因',
    intro: '日常使用时点击任一店铺小方框，会打开检查详情。这里先用一条示例练习阅读顺序。',
    kind: 'evidence',
    cards: [
      ['确认对象与时间', '核对店铺、站点、检查项、最近运行和批次，避免用错店铺或过期截图。'],
      ['理解判定依据', '阅读“需处理原因”、指标和结构化明细，再查看页面证据与截图；截图并非每次都可用。'],
      ['比较前后变化', '历史趋势和前次对比帮助你确认风险是新增、仍然存在，还是已恢复。'],
    ],
    takeaway: '可靠正常需要页面结构与页面文本两路证据。证据缺失、归属待核验或过期时，先核验再下结论。',
  },
  {
    id: 'voice', chapter: '处理运营事项', label: '评价、消息与 VOC', view: 'customer-voice', target: '[data-view-panel="customer-voice"] .section', checks: ['feedback', 'inbox', 'reviews', 'voc'],
    title: '把“买家反馈”拆成四类工作',
    intro: '四项都在“客户声音”，但时间范围、处理对象和提醒含义不同。',
    cards: [
      ['03 · Feedback：店铺服务评价', '检查北京时间当天低于 4 分的 Feedback；根据具体反馈排查服务与履约问题。'],
      ['09 · Inbox：买家消息', '未读或待回复消息需要运营跟进。平台只读消息列表，不会打开会话、标为已读或代你回复。'],
      ['04 · Reviews：商品评价', '先核对评论和 ASIN 是否归属本店，再处理低于 4 星的评价；品牌页记录不一定属于当前店铺。'],
      ['07 · VOC：客户体验', '按 ASIN 查看客户体验、退货相关记录与异常原因，为商品和售后改进提供依据。'],
    ],
    takeaway: '“已提醒并归档”表示系统已登记、减少重复提醒，不代表运营已经处理完。归属待核验也不能算正常。',
  },
  {
    id: 'product', chapter: '处理运营事项', label: '商品与活动机会', view: 'product-status', target: '[data-view-panel="product-status"] .section', checks: ['asin-health', 'outlet'],
    title: '先确认商品可售，再排查购物车与评分',
    intro: 'ASIN 是 Amazon 商品标识。“商品状态”把商品问题、活动机会和采集故障分别列出。',
    cards: [
      ['05 · ASIN 常规检查', '先判断是否激活 / 可售；在售商品再检查购物车和评分变化。无购物车与页面打不开，需要走不同处理路径。'],
      ['监测清单与复核', '持续监测、低频复核、人工停检分别展示。查看下次复核时间；低频复核不是正常，也不是商品已永久删除。调整监测策略时联系负责人。'],
      ['06 · Outlet 活动', '出现新的 Create outlet deal 机会会提醒运营评估。平台只监测机会，不会替你创建或提交活动。'],
    ],
    takeaway: '先按原因决定核验库存、可售性、购物车或商品内容；采集失败则交技术，避免把页面故障误当下架。',
  },
  {
    id: 'ads', chapter: '处理运营事项', label: '广告时段与范围', view: 'ads-watch', target: '[data-view-panel="ads-watch"] .section', checks: ['ads-status'],
    title: '广告值守负责核对，运营负责操作',
    intro: '先按组合名称特征确认范围，再联合检查组合状态及其中每个活动的开关、投放状态。组合显示投放中，不能代表其中每个活动都在投放。',
    cards: [
      ['08 · 核对开关时段', '按页面“广告检查时段”查看北京时间排程：当前默认 11:20 检查多数关闭，18:30 检查多数开启；每家店超过 50% 符合预期即正常。到点不等于已成功完成检查；显示“已暂停”时不会执行监测。'],
      ['核对广告范围', '查看“店铺广告组合范围”。名称规则缺失、分页未读全或状态矛盾时交技术 / 管理员核验，不能自行理解为全账户正常。'],
      ['少数留档，多数告警', '少数未达到预期的活动在店铺详情留档，每次重新判断；超过一半不符合时段预期才报业务异常，各半显示业务关注。投放受限不等于正常开启或已关闭。'],
    ],
    quiz: { question: '练习：广告显示“应关闭但仍开启”，平台会自动关掉吗？', options: ['会，等进度跑完即可', '不会，需要运营核对并处理'], correct: 1, explanation: '对。广告值守是只读检查，不会替运营切换开关。' },
  },
  {
    id: 'upload', chapter: '协作与日常使用', label: '认识上传中心', view: 'upload', target: '#uploadCard',
    title: '上传分三步，接收文件不等于上架成功',
    intro: '这是平台唯一受控的 Amazon 写入入口。导览只介绍流程，不选择文件、不创建任务，也不进行授权。',
    kind: 'upload',
    cards: [
      ['1 · 选对店铺，先做预检', '功能启用且你拥有权限时，选择目标店铺与 Amazon 批量模板，点击“本地预检并暂存”。这一步还没有提交到 Amazon。'],
      ['2 · 核对并逐次确认', '核对任务、店铺和文件摘要，重新输入工作台密码与页面指定短语，确认后才授权该任务提交。'],
      ['3 · 跟进最终处理结果', '到“上传任务记录”和“处理结果概览”查看批次、SKU 结果及错误。Amazon 已接收文件，不表示商品已经处理成功。'],
    ],
    quiz: { question: '练习：上传结果显示“未知”，下一步怎么做？', options: ['立即再上传一次', '先核验原任务和 Amazon 处理结果'], correct: 1, explanation: '对。结果未知时先找负责人核验原任务，避免重复提交或重复商品。' },
  },
  {
    id: 'handoff', chapter: '协作与日常使用', label: '向技术交接问题', view: 'system', target: '#sessions',
    title: '把问题交接到能直接排查的程度',
    intro: '“系统保障”帮助你区分店铺业务问题和采集链路问题，也能核对通知是否真实送达。',
    cards: [
      ['先找阻断位置', '查看紫鸟会话中心、采集故障队列和双路证据完整度。需要重新登录或修复页面时交给技术。'],
      ['交接带四样信息', '店铺与站点、检查项、发生时间 / 批次、异常文字和可用证据。不要发送密码、验证码或登录 Cookie。'],
      ['不要只等通知', '外部通道“已配置”不等于消息已送达，需看最近真实投递结果。业务待办仍以看板和有效证据为准。'],
    ],
    kind: 'handoff',
    takeaway: '交接后继续跟进修复和下一轮复检；通知发送过、旧记录归档过，都不能替代结果复核。',
  },
  {
    id: 'account', chapter: '协作与日常使用', label: '账户与权限', view: 'users', target: '#ownPasswordForm',
    title: '用自己的账户，按权限开展工作',
    intro: '运营可以查看巡检数据并修改自己的工作台密码；账号管理、广告规则和上传权限有各自的授权要求。',
    cards: [
      ['修改我的密码', '在此输入当前密码和新密码。修改成功后旧会话失效，需要重新登录；导览不会填写或提交表单。'],
      ['按钮不可用时', '先阅读页面提示，再联系管理员开通所需权限或确认功能是否启用。不要借用他人的账户来绕过权限。'],
      ['分清两种登录', '工作台账户与 Amazon 店铺账户不是一回事；访问店铺后台始终使用对应店铺的紫鸟浏览器。'],
    ],
    takeaway: '新手导览随时可重看，退出会回到开始前的页面；学习记录仅保存在此浏览器。',
  },
  {
    id: 'routine', chapter: '协作与日常使用', label: '开始你的第一次巡检', view: 'overview', target: '#scheduleList',
    title: '把这四步变成每天的工作节奏',
    intro: '现在你已经认识了各个工作区。第一次使用时，按下面的顺序完成一次业务复核。',
    kind: 'routine',
    cards: [
      ['上班：看总览与新鲜度', '核对最近批次、运营待处理、技术待修复与未完成。早 / 午班默认 08:00、15:30，具体以下方排程为准。'],
      ['处理：逐店读证据', '进入店铺风险、客户声音或商品状态，按店铺筛选；读清原因后，在对应紫鸟后台处理业务。'],
      ['到点：复核广告', '按广告检查时段确认目标广告开关符合预期；留意名称范围和采集是否成功。'],
      ['收尾：交接并等复检', '在团队现有协作渠道记录处理人、动作和待复核事项；下一轮对照证据确认恢复。'],
    ],
    takeaway: '遇到拿不准的结果，先看店铺、时间、原因和证据，再决定下一步。',
  },
];

export function normalizeTourRecord(value, lessons) {
  const ids = lessons.map((lesson) => lesson.id);
  if (!value || value.version !== 1) return { version: 1, current: ids[0], completed: [] };
  return { version: 1, current: ids.includes(value.current) ? value.current : ids[0],
    completed: [...new Set((Array.isArray(value.completed) ? value.completed : []).filter((id) => ids.includes(id)))] };
}

export const ONBOARDING_STYLES = `
  .tour-card .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .tour-entry{display:flex;align-items:center;gap:9px;width:100%;padding:11px 12px;margin:0 0 18px;border:1px solid #526641;border-radius:10px;background:#263b2c;color:#e5f8c1;font-size:12px;font-weight:700;cursor:pointer;text-align:left}.tour-entry:hover{background:#354c30;border-color:var(--accent)}.tour-entry svg{width:19px;height:19px;flex:none}.tour-entry:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .tour-layer[hidden]{display:none!important}.tour-layer{position:fixed;inset:0;z-index:100;isolation:isolate}.tour-shade{position:absolute;inset:0;background:rgba(9,24,18,.46)}.tour-spot{position:fixed;pointer-events:none;border:2px solid var(--accent);border-radius:13px;box-shadow:0 0 0 9999px rgba(9,24,18,.46),0 0 0 5px rgba(201,243,106,.18)}.tour-layer.has-spot .tour-shade{background:transparent}
  .tour-card{position:fixed;right:18px;top:18px;bottom:18px;width:414px;display:flex;flex-direction:column;overflow:hidden;background:#fff;border:1px solid #dce5d9;border-radius:20px;box-shadow:0 24px 80px rgba(9,24,18,.27);color:var(--ink)}.tour-top{display:flex;align-items:center;gap:10px;padding:18px 22px 14px;border-bottom:1px solid var(--line);flex:none}.tour-logo{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:var(--accent);color:var(--accent-ink);font-size:17px}.tour-top b{display:block;font-size:13px}.tour-top small{display:block;font-size:10px;color:var(--muted);margin-top:2px}.tour-close{margin-left:auto;width:34px;height:34px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--muted);font-size:20px;cursor:pointer}.tour-close:hover{background:var(--panel-soft)}
  .tour-progress{height:3px;background:var(--idle-soft);flex:none}.tour-progress span{display:block;height:100%;background:var(--ok);transition:width .2s}.tour-body{padding:20px 22px;overflow:auto;overscroll-behavior:contain;min-height:0;flex:1}.tour-eyebrow{font-size:10px;letter-spacing:1px;color:var(--ok);font-weight:750;margin-bottom:8px}.tour-body h2{font-size:23px;line-height:1.35;letter-spacing:-.5px;margin:0 0 10px;outline:none}.tour-intro{font-size:12px;line-height:1.85;color:var(--muted);margin:0 0 17px}.tour-goals{display:grid;gap:8px;margin:16px 0 20px}.tour-goals div{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:12px}.tour-goals i{display:grid;place-items:center;font-style:normal;width:24px;height:24px;background:var(--ok-soft);color:var(--ok);border-radius:7px;font-size:11px;font-weight:700}
  .tour-toc{border:1px solid var(--line);background:var(--panel-soft);border-radius:11px;margin:0 0 18px;padding:11px 12px}.tour-toc summary{cursor:pointer;font-size:11px;font-weight:700;color:var(--muted)}.tour-toc h3{font-size:10px;color:var(--muted);margin:14px 0 6px}.tour-toc-list{display:grid;gap:3px}.tour-toc button{width:100%;display:flex;align-items:center;gap:8px;text-align:left;border:0;background:transparent;border-radius:7px;padding:8px;color:var(--ink);font-size:11px;cursor:pointer}.tour-toc button:hover,.tour-toc button[aria-current=step]{background:#e5efdc}.tour-toc button i{font-style:normal;width:18px;font-size:10px;color:var(--muted)}.tour-toc button.done i{color:var(--ok)}
  .tour-points{display:grid;gap:10px}.tour-point{padding:12px 13px;background:#f7f9f5;border:1px solid #e6ece3;border-radius:11px}.tour-point h3{font-size:12px;margin:0 0 5px}.tour-point p{font-size:12px;line-height:1.8;color:#56665d;margin:0}.tour-takeaway{border-left:3px solid var(--ok);background:var(--ok-soft);border-radius:0 9px 9px 0;padding:11px 13px;margin-top:15px;font-size:12px;line-height:1.8;color:#2d5841}.tour-takeaway b{display:block;margin-bottom:3px;font-size:11px}.tour-context{margin:0 0 14px;border:1px solid #dbe5f0;border-radius:9px;padding:10px 12px;color:#316896;background:#f2f7fc;font-size:11px;line-height:1.7}.tour-context[hidden]{display:none}
  .tour-quiz{margin-top:16px;padding:13px;border:1px solid #d4dfc9;background:#fff;border-radius:11px}.tour-quiz h3{margin:0 0 10px;font-size:12px;line-height:1.7}.tour-answer{display:block;width:100%;padding:10px 11px;margin-top:7px;text-align:left;font-size:11px;line-height:1.6;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer}.tour-answer:hover{border-color:var(--ok)}.tour-answer[aria-pressed=true]{border-color:var(--ok);background:var(--ok-soft)}.tour-feedback{font-size:11px;line-height:1.8;margin-top:9px;color:var(--ok)}.tour-feedback.retry{color:var(--warn)}
  .tour-example{margin:15px 0;border:1px dashed #b2c59f;border-radius:11px;padding:13px;background:#fcfdf9}.tour-example small{font-size:10px;color:var(--muted);display:block;margin-bottom:8px}.tour-example details{font-size:12px}.tour-example summary{cursor:pointer;color:var(--bad);font-weight:700;padding:9px 10px;background:var(--bad-soft);border-radius:8px}.tour-example dl{display:grid;grid-template-columns:58px 1fr;gap:8px;font-size:11px;line-height:1.7;margin-bottom:0}.tour-example dt{color:var(--muted)}.tour-example dd{margin:0}.tour-copy{font-size:11px;line-height:1.8;margin:10px 0 0;padding:10px;border:1px dashed var(--line);border-radius:8px;user-select:text}
  .tour-footer{padding:15px 22px 18px;border-top:1px solid var(--line);background:#fff;flex:none}.tour-actions{display:flex;gap:8px;align-items:center}.tour-actions button{height:40px;border-radius:10px;padding:0 14px;font-size:12px;font-weight:700;cursor:pointer}.tour-back{border:1px solid var(--line);background:#fff;color:var(--ink)}.tour-next{flex:1;border:1px solid var(--side);background:var(--side);color:#f0fadf}.tour-next:hover{background:#2d4534}.tour-restart{border:0;background:transparent;color:var(--muted);padding:0!important}.tour-footnote{margin:10px 0 0;color:var(--muted);font-size:10px;line-height:1.6}.tour-card button:focus-visible,.tour-card summary:focus-visible{outline:2px solid var(--ok);outline-offset:3px}.tour-card button:disabled{opacity:.4;cursor:default}
  @media(min-width:1120px){body.tour-active .app{width:auto;margin-right:448px}body.tour-active .app{grid-template-columns:72px minmax(0,1fr)}body.tour-active .sidebar{padding-left:10px;padding-right:10px}body.tour-active .brand{padding-left:8px}body.tour-active .brand>div:last-child,body.tour-active .navlabel,body.tour-active .nav a>span:last-child,body.tour-active .sidefoot p{display:none}body.tour-active .nav a{justify-content:center}body.tour-active .content{padding:22px}body.tour-active .topbar{padding:0 22px}body.tour-active .hero{display:block}body.tour-active .overall{margin-top:16px}body.tour-active .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}body.tour-active .controls{flex-wrap:wrap}body.tour-active .section-head{flex-wrap:wrap}body.tour-active .tour-entry{padding:10px;justify-content:center}body.tour-active .tour-entry span{display:none}}
  @media(min-width:641px) and (max-width:1080px){.sidebar .tour-entry{padding:10px;justify-content:center}.sidebar .tour-entry span{display:none}}
  @media(max-width:1119px){.tour-card{left:12px;right:12px;top:auto;bottom:12px;width:auto;max-height:56vh;max-height:56dvh;border-radius:17px}.tour-top{padding:11px 16px}.tour-top small{display:none}.tour-body{padding:16px}.tour-body h2{font-size:21px}.tour-footer{padding:11px 16px}.tour-footnote{margin-top:7px}.tour-layer.welcome .tour-card{top:12px;max-height:none}.tour-layer.welcome .tour-top small{display:block}}
  @media(max-width:640px){.sidebar .sidefoot{display:block;position:absolute;right:14px;top:12px;margin:0;padding:0;border:0}.sidebar .sidefoot .live,.sidebar .sidefoot p{display:none}.sidebar .tour-entry{margin:0;width:auto;padding:8px 10px;gap:6px;font-size:11px}.sidebar .tour-entry svg{width:15px;height:15px}.sidebar .brand{padding-right:110px}}
  @media(prefers-reduced-motion:reduce){.tour-progress span{transition:none}}
`;

export const ONBOARDING_ENTRY = `<button class="tour-entry" id="startOperatorTour" type="button" aria-haspopup="dialog" aria-controls="operatorTour" title="新手导览 · 运营入门"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 4.5c3-1 6-.5 9 1.5 3-2 6-2.5 9-1.5v15c-3-1-6-.5-9 1.5-3-2-6-2.5-9-1.5z"/><path d="M12 6v15M6 9h3M15 9h3M6 13h3M15 13h3"/></svg><span>新手导览</span></button>`;

export const ONBOARDING_MARKUP = `<div class="tour-layer" id="operatorTour" hidden>
  <div class="tour-shade" aria-hidden="true"></div><div class="tour-spot" id="tourSpot" aria-hidden="true" hidden></div>
  <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourIntro" tabindex="-1">
    <header class="tour-top"><div class="tour-logo" aria-hidden="true">↗</div><div><b>新手导览 · 运营入门</b><small id="tourStepLabel">从认识工作台到独立跟进业务</small></div><button class="tour-close" id="tourClose" type="button" aria-label="退出导览，保留学习进度" title="退出导览 · Esc">×</button></header>
    <div class="tour-progress" role="progressbar" aria-label="导览学习完成进度" aria-valuemin="0" aria-valuemax="12" aria-valuenow="0"><span id="tourProgressFill"></span></div>
    <div class="tour-body" id="tourBody"></div>
    <footer class="tour-footer"><div class="tour-actions"><button class="tour-back" id="tourBack" type="button">上一步</button><button class="tour-next" id="tourNext" type="button">开始导览</button><button class="tour-restart" id="tourRestart" type="button">从头开始</button></div><p class="tour-footnote" id="tourFootnote">可随时退出与重看 · 学习记录仅保存在此浏览器</p></footer>
  </section>
</div>`;

/** Serialized into the dashboard's existing script; all dependencies are explicit. */
export function installOperatorTour({ window, document, lessons, normalizeRecord, activateView, readData, readUpload }) {
  const q = (selector) => document.querySelector(selector);
  const root = q('#operatorTour'), card = root.querySelector('.tour-card'), app = q('.app');
  const body = q('#tourBody'), button = q('#startOperatorTour');
  const storageKey = 'amzguard.operator-tour.v1';
  const escape = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
  let record, active = false, index = -1, returnView, returnScroll, returnFocus, originalOverflow, originalInert;
  let frame = 0, observer, storageAvailable = true;
  function readRecord() {
    try { record = normalizeRecord(JSON.parse(window.localStorage.getItem(storageKey)), lessons); }
    catch { record = normalizeRecord(null, lessons); }
  }
  function saveRecord() {
    try { window.localStorage.setItem(storageKey, JSON.stringify(record)); }
    catch { storageAvailable = false; }
  }
  function toc(open = false) {
    let chapter = '';
    return '<details class="tour-toc"' + (open ? ' open' : '') + '><summary>学习目录 · 已学 ' + record.completed.length + ' / ' + lessons.length + ' 站</summary><div class="tour-toc-list">' + lessons.map((lesson, i) => {
      const heading = chapter !== lesson.chapter ? '<h3>' + escape(lesson.chapter) + '</h3>' : ''; chapter = lesson.chapter;
      const done = record.completed.includes(lesson.id);
      return heading + '<button type="button" data-tour-step="' + i + '" class="' + (done ? 'done' : '') + '"' + (i === index ? ' aria-current="step"' : '') + '><i aria-hidden="true">' + (done ? '✓' : String(i + 1).padStart(2, '0')) + '</i><span>' + escape(lesson.label) + (done ? '<span class="sr-only">（已学）</span>' : '') + '</span></button>';
    }).join('') + '</div></details>';
  }
  function context() {
    const element = q('#tourContext'); if (!element) return;
    let message = '';
    if (!readData()) message = '当前看板数据尚未就绪，你仍可学习使用方法；此处不会将示例当作真实巡检结果。';
    else if (lessons[index]?.kind === 'upload') {
      const upload = readUpload();
      message = !upload ? '正在读取当前上传状态；是否可用以上传中心的实时提示为准。'
        : !upload.enabled ? '当前上传功能未启用。先了解流程，需要使用时联系管理员。'
          : !upload.authorized ? '当前账户没有上传权限。先了解流程，需要使用时联系管理员。'
            : '当前账户具备上传权限。此导览只讲解，实际提交仍需逐任务确认。';
    }
    element.hidden = !message; element.textContent = message;
  }
  function positionSpot() {
    frame = 0; if (!active || index < 0) return;
    context();
    const target = q(lessons[index].target), spot = q('#tourSpot');
    if (!target || !target.getClientRects().length) { spot.hidden = true; root.classList.remove('has-spot'); return; }
    const box = target.getBoundingClientRect(), panel = card.getBoundingClientRect();
    const mobile = window.innerWidth < 1120;
    const left = Math.max(8, box.left - 5), top = Math.max(8, box.top - 5);
    const right = Math.min(mobile ? window.innerWidth - 8 : panel.left - 16, box.right + 5);
    const bottom = Math.min(mobile ? panel.top - 12 : window.innerHeight - 8, box.bottom + 5);
    const visible = right - left > 20 && bottom - top > 20;
    spot.hidden = !visible; root.classList.toggle('has-spot', visible);
    if (visible) Object.assign(spot.style, { left: left + 'px', top: top + 'px', width: (right - left) + 'px', height: (bottom - top) + 'px' });
  }
  function scheduleSpot() { if (active && !frame) frame = window.requestAnimationFrame(positionSpot); }
  function show(nextIndex) {
    index = nextIndex;
    if (index >= 0) { record.current = lessons[index].id; saveRecord(); }
    root.classList.toggle('welcome', index < 0);
    root.classList.remove('has-spot'); q('#tourSpot').hidden = true;
    q('#tourProgressFill').style.width = (record.completed.length * 100 / lessons.length) + '%';
    const progress = q('#tourProgressFill').parentElement;
    progress.setAttribute('aria-valuemax', String(lessons.length)); progress.setAttribute('aria-valuenow', String(record.completed.length));
    progress.setAttribute('aria-valuetext', '已学 ' + record.completed.length + ' / ' + lessons.length + ' 站');
    q('#tourBack').hidden = index < 0; q('#tourRestart').hidden = index >= 0 || !record.completed.length && record.current === lessons[0].id;
    q('#tourFootnote').textContent = storageAvailable ? '随时退出可保留进度 · 目录可跳转重看 · Esc 退出' : '浏览器未允许保存学习记录；本次仍可正常完成导览。';
    if (index < 0) {
      const started = record.completed.length || record.current !== lessons[0].id;
      q('#tourStepLabel').textContent = '约 8 分钟 · ' + lessons.length + ' 站 · 为运营准备';
      q('#tourNext').textContent = record.completed.length === lessons.length ? '再走一遍' : started ? '继续上次学习' : '开始导览';
      body.innerHTML = '<div class="tour-eyebrow">你的第一天，从这里开始</div><h2 id="tourTitle" tabindex="-1">看懂店铺状态，<br>知道下一步做什么。</h2><p class="tour-intro" id="tourIntro">跟着真实页面认识运营功能。每一站只解决一个工作问题，也有小练习帮助你判断。' + (record.completed.length === lessons.length ? '你已学完全部内容，随时可以按目录复习。' : '') + '</p><div class="tour-goals"><div><i>1</i>找出今天需要你处理的店铺</div><div><i>2</i>读懂证据，把问题交给对的人</div><div><i>3</i>掌握巡检、复检与上传的工作边界</div></div>' + toc(true) + '<div class="tour-takeaway"><b>放心学习</b>导览只切换页面、展示说明与练习，不会修改广告、回复买家消息或提交上传。退出后回到你原来的页面。</div>';
    } else {
      const lesson = lessons[index]; activateView(lesson.view);
      q('#tourStepLabel').textContent = lesson.chapter + ' · 第 ' + (index + 1) + ' / ' + lessons.length + ' 站';
      q('#tourBack').textContent = index === 0 ? '学习目录' : '上一步';
      q('#tourNext').textContent = index === lessons.length - 1 ? '回总览开始工作' : '我了解了，下一步';
      body.innerHTML = toc() + '<div class="tour-eyebrow">' + escape(lesson.chapter) + '</div><h2 id="tourTitle" tabindex="-1">' + escape(lesson.title) + '</h2><p class="tour-intro" id="tourIntro">' + escape(lesson.intro) + '</p><div class="tour-context" id="tourContext" role="status" hidden></div><div class="tour-points">' + lesson.cards.map(([title, text]) => '<article class="tour-point"><h3>' + escape(title) + '</h3><p>' + escape(text) + '</p></article>').join('') + '</div>'
        + (lesson.kind === 'evidence' ? '<div class="tour-example"><small>练习示例 · 非真实店铺结果</small><details><summary>示例店铺 · 绩效业务异常（点击展开）</summary><dl><dt>对象</dt><dd>示例店铺 / US / 绩效检查</dd><dt>采集</dt><dd>示例早班批次；正式处理需核对实际时间</dd><dt>原因</dt><dd>绩效页面仍显示待处理风险</dd><dt>证据</dt><dd>结构化明细与页面文本一致；截图用于复核</dd><dt>下一步</dt><dd>运营通过对应店铺紫鸟核验与处理，下一轮确认风险是否消失</dd></dl></details></div>' : '')
        + (lesson.kind === 'handoff' ? '<div class="tour-copy"><b>交接信息模板（按实际内容填写）</b><br>店铺 / 站点：<br>检查项与采集时间：<br>异常原文与影响：<br>运行 ID / 截图或证据链接：<br>已核验的情况与待协助事项：</div>' : '')
        + (lesson.takeaway ? '<div class="tour-takeaway"><b>记住这一点</b>' + escape(lesson.takeaway) + '</div>' : '')
        + (lesson.quiz ? '<section class="tour-quiz"><h3>' + escape(lesson.quiz.question) + '</h3>' + lesson.quiz.options.map((option, i) => '<button type="button" class="tour-answer" data-tour-answer="' + i + '" aria-pressed="false">' + escape(option) + '</button>').join('') + '<div class="tour-feedback" id="tourFeedback" role="status"></div></section>' : '');
      context();
      const target = q(lesson.target);
      if (target) {
        const header = q('.topbar').getBoundingClientRect();
        window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - header.height - 22), behavior: 'instant' });
      }
    }
    body.scrollTop = 0; q('#tourTitle').focus({ preventScroll: true }); scheduleSpot();
  }
  function start() {
    if (active) return;
    readRecord(); active = true;
    returnView = q('[data-view-panel].active')?.getAttribute('data-view-panel') || 'overview';
    returnScroll = window.scrollY; returnFocus = document.activeElement; originalOverflow = document.body.style.overflow; originalInert = app.inert;
    root.hidden = false; document.body.classList.add('tour-active');
    app.inert = true; document.body.style.overflow = 'hidden';
    show(-1);
    if (window.ResizeObserver) { observer = new window.ResizeObserver(scheduleSpot); observer.observe(app); observer.observe(card); }
  }
  function stop(destination) {
    if (!active) return;
    active = false; if (frame) window.cancelAnimationFrame(frame); frame = 0; observer?.disconnect();
    root.hidden = true; document.body.classList.remove('tour-active'); app.inert = originalInert; document.body.style.overflow = originalOverflow;
    activateView(destination || returnView);
    if (destination) window.history.replaceState(null, '', '#' + destination);
    window.scrollTo({ top: destination ? 0 : returnScroll, behavior: 'instant' });
    (returnFocus?.isConnected ? returnFocus : button).focus({ preventScroll: true });
  }
  button.addEventListener('click', start);
  q('#tourClose').addEventListener('click', () => stop());
  q('#tourBack').addEventListener('click', () => show(index - 1));
  q('#tourRestart').addEventListener('click', () => { record = normalizeRecord(null, lessons); saveRecord(); show(0); });
  q('#tourNext').addEventListener('click', () => {
    if (index < 0) {
      if (record.completed.length === lessons.length) { record = normalizeRecord(null, lessons); saveRecord(); }
      show(Math.max(0, lessons.findIndex((lesson) => lesson.id === record.current))); return;
    }
    if (!record.completed.includes(lessons[index].id)) record.completed.push(lessons[index].id);
    saveRecord();
    if (index === lessons.length - 1) stop('overview'); else show(index + 1);
  });
  body.addEventListener('click', (event) => {
    const step = event.target.closest('[data-tour-step]');
    if (step) { const next = Number(step.dataset.tourStep); if (Number.isInteger(next) && next >= 0 && next < lessons.length) show(next); return; }
    const answer = event.target.closest('[data-tour-answer]'); const quiz = lessons[index]?.quiz;
    if (answer && quiz) {
      const correct = Number(answer.dataset.tourAnswer) === quiz.correct;
      body.querySelectorAll('[data-tour-answer]').forEach((node) => node.setAttribute('aria-pressed', String(node === answer)));
      q('#tourFeedback').className = 'tour-feedback' + (correct ? '' : ' retry');
      q('#tourFeedback').textContent = correct ? quiz.explanation : '再想一想：先确认状态与职责。可以重新选择，也可以回看上方说明。';
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stop(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...card.querySelectorAll('button:not([disabled]),summary,[href]')].filter((node) => node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (!first) { event.preventDefault(); card.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement.id === 'tourTitle')) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener('resize', scheduleSpot);
  window.addEventListener('scroll', scheduleSpot, true);
  window.addEventListener('hashchange', () => { if (active) stop(window.location.hash.slice(1) || 'overview'); });
  // Background report refreshes can move a highlighted section or change access hints.
  window.setInterval(() => { if (active) { context(); scheduleSpot(); } }, 2000);
  return { start, stop };
}
