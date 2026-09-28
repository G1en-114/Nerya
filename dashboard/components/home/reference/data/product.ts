export type LocalizedText = { zh: string; en: string };

export type ProductFeature = {
  id: 'strategy' | 'team' | 'evolution' | 'vault';
  title: LocalizedText;
  description: LocalizedText;
  steps: [LocalizedText, LocalizedText, LocalizedText];
  cta: LocalizedText;
  /** Internal demo route. Link as /demo/#${route}. */
  route: string;
  detail?: LocalizedText;
};

// Copy and implementation boundaries: docs/astro-product-facts-20260926.md.
// The lead may adjust the hero without changing the feature contract.
export const hero = {
  title: {
    zh: '把策略想法\n交给 Agent 团队',
    en: 'Bring your strategy ideas\nto an Agent team',
  },
  description: {
    zh: '说出你的想法，让 Agent 编写策略、分工研究并定期复盘。你可以查看证据并审核改动。',
    en: 'Describe your idea. Let Agents write the strategy, share research tasks and review runs on a schedule. Inspect the evidence and approve strategy updates.',
  },
  cta: { zh: '体验策略创建', en: 'Explore strategy creation' },
  route: '/chat/demo-strategy',
};

export const features: ProductFeature[] = [
  {
    id: 'strategy',
    title: { zh: '说出想法 开始构建', en: 'Turn an idea into a strategy' },
    description: {
      zh: '描述交易逻辑与约束。Agent 编写策略草稿并执行校验，你在同一对话里查看逻辑说明和回测结果。',
      en: 'Describe your trading rules and constraints. The Agent writes and checks a strategy draft. Read the logic and backtest results in the same conversation.',
    },
    steps: [
      { zh: '描述想法', en: 'Describe your idea' },
      { zh: '生成工作流', en: 'Generate the workflow' },
      { zh: '检查策略包', en: 'Inspect the package' },
    ],
    cta: { zh: '体验策略创建', en: 'Explore strategy creation' },
    route: '/chat/demo-strategy',
    detail: {
      zh: '草稿保留参数和逻辑说明。启用前需完成验证与审核。',
      en: 'Drafts include parameters and logic notes. Validate and approve the candidate before activation.',
    },
  },
  {
    id: 'team',
    title: { zh: '让 Agent 分工研究', en: 'Give Agents a shared research task' },
    description: {
      zh: '研究员分头分析行情与消息，风险审阅员检查假设。协调 Agent 汇总证据与结论。',
      en: 'Researchers examine market data and news in parallel. A risk reviewer checks assumptions. The lead Agent brings the evidence and findings together.',
    },
    steps: [
      { zh: '分配任务', en: 'Assign tasks' },
      { zh: '并行研究', en: 'Research in parallel' },
      { zh: '汇总证据', en: 'Combine evidence' },
    ],
    cta: { zh: '查看 Agent 团队', en: 'Explore the Agent team' },
    route: '/agents',
    detail: {
      zh: '团队按任务依赖推进。缺少必需任务或证据时，运行会标记为受阻。',
      en: 'Team members follow task dependencies. Missing required work or evidence leaves the run blocked.',
    },
  },
  {
    id: 'evolution',
    title: { zh: '自主复盘 迭代策略', en: 'Let Agents review and refine' },
    description: {
      zh: '启用复盘计划后，Agent 分析运行记录并提出调整建议。你可以查看依据和候选改动，审核策略更新。',
      en: 'Enable a review schedule. The Agent examines run history and proposes changes. Inspect the evidence and candidate edits before approving strategy updates.',
    },
    steps: [
      { zh: '读取运行记录', en: 'Read run history' },
      { zh: '提出候选改动', en: 'Propose candidate changes' },
      { zh: '验证与审核', en: 'Validate and review' },
    ],
    cta: { zh: '查看复盘与提案', en: 'Explore reviews and proposals' },
    route: '/self-evolution',
    detail: {
      zh: '策略代码更新需要审核。可选自动应用仅覆盖通过验证的限定提示词与配置改动。',
      en: 'Strategy code updates require approval. Optional auto-apply covers validated prompt and configuration edits within a fixed allowlist.',
    },
  },
  {
    id: 'vault',
    title: { zh: '把密钥存入本地 Vault', en: 'Keep credentials in your local Vault' },
    description: {
      zh: '将账户密钥加密存入本地 Vault，并在账户配置中使用凭据引用。',
      en: 'Store account credentials encrypted in the local Vault and use references in account configuration.',
    },
    steps: [
      { zh: '存入凭据', en: 'Store credentials' },
      { zh: '传递引用', en: 'Pass references' },
      { zh: '运行时使用', en: 'Use at runtime' },
    ],
    cta: { zh: '查看设置', en: 'Explore settings' },
    route: '/settings',
    detail: {
      zh: '标准安装使用 AES-GCM 与 scrypt。加密保护落盘数据，运行进程仍需使用明文凭据。',
      en: 'Standard installations use AES-GCM and scrypt to encrypt stored data. The runtime still needs plaintext credentials when using them.',
    },
  },
];

// Secondary content: research categories do not imply equal execution support.
export const markets = [
  {
    id: 'crypto',
    title: { zh: '加密货币', en: 'Crypto' },
    description: { zh: '研究行情与链上信号', en: 'Research price action and on-chain signals' },
    route: '/strategies?strategy_id=btc_trend_guard',
  },
  {
    id: 'prediction',
    title: { zh: '预测市场', en: 'Prediction markets' },
    description: { zh: '比较事件概率与结算规则', en: 'Compare event probabilities and resolution rules' },
    route: '/strategies?strategy_id=event_probability',
  },
  {
    id: 'futures',
    title: { zh: '期货', en: 'Futures' },
    description: { zh: '研究期限结构与换月条件', en: 'Study term structure and contract rolls' },
    route: '/strategies?strategy_id=futures_term_structure',
  },
  {
    id: 'equities',
    title: { zh: 'A 股', en: 'A-shares' },
    description: { zh: '研究因子与交易日历', en: 'Research factors and trading calendars' },
    route: '/strategies?strategy_id=ashare_factor_rotation',
  },
];

export const connectorAuthoring = {
  title: { zh: '用自然语言提出接入需求', en: 'Describe the connector you need' },
  description: {
    zh: '告诉 Agent 目标平台与数据需求。Agent 检查现有连接器，整理接口约定并准备接入提案。',
    en: 'Tell the Agent which platform and data you need. It checks existing connectors, maps API requirements and prepares an integration proposal.',
  },
  detail: {
    zh: '新增适配代码需要验证与审核。接口文档和接入提案不能证明连接已可用。',
    en: 'New adapter code needs validation and approval. API documentation and a proposal do not establish a working connection.',
  },
  cta: { zh: '在对话中提出需求', en: 'Describe an integration in chat' },
  route: '/chat/demo-strategy',
};
