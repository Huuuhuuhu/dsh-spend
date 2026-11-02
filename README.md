# dsh-spend

> Actual DeepSeek billing, inline in the DSH sidebar.

一个零依赖、无需构建的 DSH 插件：

- 左下角账户行右侧显示真实账户余额
- 工作区行右侧显示该工作区的实际累计扣款
- 会话行原本的时间位置显示该会话的实际累计扣款
- 保留 DSH 原生悬停行为：会话行悬停时金额被原生按钮盖住，悬停卡片保持原版

金额不是按官方价目表估算的总额，而是从 DeepSeek Platform 用量页使用的实际小时账单接口读取 CNY 扣款，再按会话日志中的小时级 token 结构和 Search 次数归属到会话。

## 环境要求

- 已在 DSH 中登录 DeepSeek 账号（使用账号登录，不是 API Key）
- CNY 账户
- 中国时区（代码固定按 UTC+8 划分自然日）
- 测试环境：DSH `0.2.1-rc.5`，Node 24

## 安装

插件是完全独立的目录，不需要 `pnpm install`，不需要构建，也不依赖任何第三方包。

1. 把整个 `dsh-spend` 目录复制到对方机器上的任意位置。
2. 在 DSH 中安装这个本地 bundle 目录；或者直接从 GitHub 安装：

```sh
dsh plugin --profile desktop add github:Huuuhuuhu/dsh-spend
```

本地目录方式：

```sh
dsh plugin --profile desktop add "link:D:\path\to\dsh-spend"
```

Web profile 把 `desktop` 换成 `web`。

3. 如果安装后没有立即出现，重启 DSH。

安装完成后无需配置。插件会复用当前 DSH 已登录的 DeepSeek Platform 会话。

## 卸载

在 DSH 插件管理器中禁用或移除 `dsh-spend`。

插件卸载时会移除插入的金额、恢复被替换的时间文本，并注销路由。

## 工作原理

1. 读取 DSH 会话的 token 日志，建立每个会话、每个小时、每个模型的权重。
2. 从 Platform 读取 DSH API Key 的实际小时账单（模型费用 + 函数调用费用）。
3. 每个小时、每个模型的实际费用只分给该小时使用该模型的会话；Search 费用按 Search 次数分。
4. 重叠小时使用官方 CNY 价目中的缓存命中/未命中/输出相对价作为归属权重；它只影响分摊，不影响实际总额。
5. 工作区费用为工作区下所有会话（含子会话）的归属金额之和。
6. 账户余额从 `deepseekAccount.getBalance()` 读取。

如果某小时只有一个会话活跃，该小时费用是精确的。多个会话同一小时重叠时，按 token 计费结构权重分摊；Platform 没有暴露到 sessionId，因此不存在绝对精确的逐会话账单。

## 限制

- Platform 的用量接口是网页内部接口，不是公开 API；Platform 改版后可能失效（失效时金额显示 `—`）。
- 拉取失败时保留上次数据，并把金额变淡，直到下一次成功刷新。
- 当前小时账单可能延迟结算，界面通常最多滞后约 30 秒，具体取决于 Platform 结算时间。
- 同一账号有多个 DSH 客户端共用 DSH Key 时，小时账单会包含它们，本地归属可能偏大。
- 非 DSH Key（普通 API Key）的消费不计入。
- 工作区总额包含子会话，所以可能大于侧栏可见会话金额之和。
- 金额用于展示和分摊；最终账单以 DeepSeek Platform 为准。

## 安全

- Platform token 仅在 Host 进程内使用，不发送到浏览器。
- 状态路由只接受 loopback 请求，并通过 DSH Connection 的浏览器鉴权；返回只读 JSON。
- 插件不修改 DSH 核心文件，不写入会话日志。

## 文件

- `index.js`：Host 半，Platform 账单读取与会话归属
- `client.js`：Client 半，侧栏 DOM 装饰
- `cordis.patch.yml`：bundle 安装行
- `locale/`、`icon.svg`：插件显示元数据

## License

MIT
