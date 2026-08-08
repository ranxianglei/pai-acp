[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Billion-Context</strong> — <a href="https://pi.dev">Pi</a> 的上下文压缩插件
<br />
由模型决定<em>何时</em>压缩、压缩<em>什么</em> — 而非硬性截断。
</p>

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context-pi"><img src="https://img.shields.io/npm/v/billion-context-pi.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context-pi/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context-pi.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context-pi"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context--pi-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>pi install npm:billion-context-pi</code>
</p>

---

## 为什么选择 billion-context

当对话变长,模型的上下文会耗尽。多数工具采用硬截断 —— 静默丢弃早期消息。**billion-context** 把 `compress` 工具交给模型:由 LLM 决定**何时**压缩、压缩**什么**,将内容压缩成高保真摘要,在回收上下文空间的同时保留关键细节(文件路径、决策、错误字符串)。

与 Pi 内置的自动压缩(把所有内容替换成单个摘要)不同,billion-context:

- **保留结构** — 压缩的范围变成带标签的块,可后续解压
- **多级压缩** — 摘要可被进一步蒸馏(T1 → T2 → T3),随会话增长保持有界
- **可搜索** — `search_context` 无需解压即可搜索已压缩块内的信息
- **有选择性** — 受保护的工具、用户消息、近期工作集永不被压缩

这使得:

1. **一个会话即可支撑海量工作。** 根据三级压缩架构的模拟测试(见 [opencode-acp](https://github.com/ranxianglei/opencode-acp)),单会话累计可处理约 100 亿至 600 亿 token —— 同时对遥远的关键信息(路径、决策、签名)保持长久记忆。用户可以在**同一个会话里连续工作几个月**,而无需因为上下文膨胀而开新会话丢上下文。
2. **上下文长期保持精简。** 实际运行中上下文通常稳定在 15 万 token 以下(opencode-acp 实测维持在 20 万以下),相比传统压缩方案动辄撑到 100 万上下文,**单会话累计可节省近 5 倍的 token 费用**。

## 安装

```bash
pi install npm:billion-context-pi
```

完成。扩展在下次 Pi 启动时自动加载。无需配置 —— 它会自动读取模型的上下文窗口。

> **建议先卸载 `pi-subagents`(可选,推荐)。** billion-context-pi 自带 `acp_delegate` 子代理工具(见下文),以极低的上下文成本(~600 tok vs ~7K tok/轮)替代 pi-subagents。如果你已安装 pi-subagents,卸载它以避免重复的委派工具:
> ```bash
> pi remove npm:pi-subagents
> ```

## 工作原理

billion-context 拦截 Pi 的 `context` 事件(每次 LLM 调用前触发),运行一个 8 阶段管线:

```
assign refs → sync blocks → prune → filter → hide calls → recommend → nudge → emergency truncate
```

每条消息获得一个不可见的 `<acp>` 引用标签(`m00001`、`m00002`、...),对模型可见但用户不可见。模型用这些引用来指定压缩范围。

Pi 内置的自动压缩会被取消 —— billion-context 是唯一的上下文管理者。

## 插件兼容性与排序

billion-context 通过拦截 Pi 的 `context` 事件接管上下文管理。**Pi 没有插件优先级机制** —— 当多个扩展为同一个事件注册 handler 时,它们按固定顺序(加载顺序)执行,没有 `priority`/`weight` 字段,用户也无法控制顺序。`context` 事件尤其是一个*管线*:每个 handler 都接收上一个 handler 的输出,没有短路,**最后一个** handler 对发给模型的内容拥有最终决定权。

这带来两个实际影响:

1. **只保留一个上下文压缩插件。** 如果同时运行两个压缩插件(例如 billion-context-pi 和另一个),它们都会改写消息列表、互相覆盖 —— 已压缩的范围可能被重新展开或破坏。Pi 的内置自动压缩已由 billion-context-pi 自动取消,但任何*第三方*压缩/compaction 扩展都应卸载。

2. **即使只有一个压缩插件,在少数情况下仍可能出现干扰。** Pi 下的加载顺序由文件系统发现顺序(`fs.readdirSync` 遍历 `.pi/extensions/` → 全局 → 包)决定,并不完全确定。如果另一个(非压缩类)扩展也 hook 了 `context` 事件、且恰好加载在 billion-context-pi *之后*,它可能修改压缩后的输出。billion-context-pi 从会话日志重建工作集(而非链式输入),这让它对*排在它之前*的 handler 鲁棒 —— 但无法防御*排在它之后*的 handler。这是 Pi 扩展模型的固有限制;若你观察到上下文行为异常,请检查是否有其他已安装扩展拦截了 `context` 事件。

## 模型工具

| 工具 | 作用 |
|------|------|
| `compress` | 用详细摘要替换连续的消息范围 |
| `decompress` | 恢复之前压缩的块内容 |
| `search_context` | 按关键词搜索已压缩块摘要(及可见消息) |
| `acp_status` | 显示上下文用量、已压缩块、可压缩范围 |
| `acp_delegate` | 为某个任务派生一个干净上下文的子代理(审查 / 调研 / 实现 / 规划 / 建议) |
| `acp_delegate_wait` | 阻塞等待委派任务完成(返回结果,否则超时) |
| `acp_delegate_cancel` | 按 runId 取消正在运行的委派任务 |

### acp_delegate — 干净上下文委派

把一个自包含的任务交给一个运行在干净上下文中的新 pi 进程。五个内置角色,各自有系统提示和**软工具护栏**:

| 角色 | 工具 | 适用场景 |
|------|------|----------|
| `reviewer` | read, bash, grep, find, ls + ACP | 只读代码审查(bug、风险、file:line) |
| `researcher` | read, bash, grep, find, ls + ACP | 只读代码库调研 |
| `worker` | read, edit, write, bash | 修改代码 |
| `planner` | read, bash, grep, find, ls + ACP | 分析 + 提出分步计划 |
| `oracle` | read, bash, grep, find, ls + ACP | 回答问题 / 建议 |

只读角色(reviewer、researcher、planner、oracle)获得受限工具白名单(`read, bash, grep, find, ls`)+ ACP 上下文工具(`compress, decompress, search_context, acp_status`),以便管理自己的上下文。这能防止意外修改文件,但 `bash` 可绕过 - **这是护栏,不是安全边界**。

Worker 运行在 Pi 的完整默认工具集上 - 不应用 `--tools` 白名单,因此任何已加载的扩展或自定义工具(如 ACP、LSP、MCP)保持可用。这确保主任务委派能力完整。上表中的 `read, edit, write, bash` 仅反映核心工具。

委派的完整结果保存到文件(`/tmp/acp-delegate/<runId>.out`);工具结果和注入通知只携带**任务标题 + 文件路径**(无预览)- 需要细节时用 `read` 读取。这让父上下文保持精简。

- **交互(TUI)与 RPC 模式**:`async:true`(默认)在后台运行子进程;完成时一条简短通知注入到聊天框。
- **Print / JSON 模式**(`pi -p`、SDK):`async:true` 自动降级为**同步** — 结果在同一轮作为工具结果返回(父进程一轮后即退出,后台注入会丢失)。

在**交互 TUI** 中,异步运行还会在编辑器下方显示一个实时状态 widget(角色、已运行秒数、任务预览),让你随时知道什么在跑、跑了多久。RPC/print/JSON 模式自动禁用。

## `/acp` 命令

为用户提供丰富的状态显示:

```
╭─────────────────────────────────────────────╮
│           ACP Context Analysis              │
╰─────────────────────────────────────────────╯
 billion-context-pi@0.1.14

Context: 12% (120K / 1.0M)
Growth: +15K since last nudge

Token Breakdown:
  System     ░░░░░░░░░░░░░░░░░░░░   2%  2.1K
  Tool       ████████████░░░░░░░░  58%  69.6K
  Summaries  ████░░░░░░░░░░░░░░░░  20%  24.0K
  Code       ██░░░░░░░░░░░░░░░░░░  10%  12.0K
  Text       █░░░░░░░░░░░░░░░░░░░   5%  6.0K

Blocks: 3 active (3.7K summary, 15.2K original compressed)
  b1 (T1)  3.7K→599  age=5m  "API exploration"
  b2 (T1)  8.2K→2.1K  age=2m  "Debug session"
  b3 (T2)  3.3K→1.0K  age=1m  "Architecture review"
```

## 配置

billion-context-pi 开箱即用,无需任何配置。可以在 JSON 配置文件中设置三个可选 key。

### 配置文件

创建 `~/.pi/acp.json`(全局)和/或 `<项目>/.pi/acp.json`(项目级,覆盖全局):

```json
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000,
  "delegate": true,
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000
}
```

| Key | 默认值 | 说明 |
|-----|--------|------|
| `debug` | `false` | 将诊断事件写入 `~/.pi/acp-debug.log`。也可用环境变量 `ACP_DEBUG=1` 启用。 |
| `autoUpdate` | `true` | Pi 启动时检查 npm 是否有更新版本并自动安装(限频:每 3 分钟最多一次检查)。禁用以避免所有启动时的网络请求。 |
| `modelContextLimit` | *(自动)* | 覆盖上下文上限(token 数)。默认为模型的 `contextWindow`。 |
| `delegate` | `true` | 启用 `acp_delegate` 工具(delegate/wait/cancel)及其系统提示词段落。设为 `false` 则不注册这些工具(例如你用了别的子代理扩展,或跑 headless 场景异步注入没有意义)。 |
| `toolBashDefaultTimeout` | `60` | 当模型未指定 `timeout` 时注入 `bash` 工具的超时秒数。Pi **本身没有默认超时**,不加这个,一次遗漏的超时可能挂起几千秒。超时后会提示模型用更大的 `timeout` 重跑。设为 `0` 恢复 Pi 的无界行为。 |
| `toolOutputMaxBytes` | `200000` | 工具结果文本硬上限(字节,约 5000 行 @ ~40 字节/行,通过 `tool_result` hook 应用)。用于兜住 Pi 自身 50KB/2000 行截断管不到的输出(例如 Pi 未加限制的工具)。触发截断时会告诉模型如何查看完整输出——对 `bash`,完整输出在其临时文件(`BashToolDetails.fullOutputPath`)中;设更小(如 `8192`)可更省上下文,设 `0` 关闭。 |

> **只有这六个 key 会被 `acp.json` 读取。** 其他调优参数(`preserveRecentMessages`、`protectedTools`、nudge 阈值)是代码级的,不向用户开放。

### 环境变量

| 变量 | 作用 |
|------|------|
| `ACP_AUTO_UPDATE` | 设为 `0` / `false` / `no` / `off`(不区分大小写)以禁用自动更新,覆盖配置值。 |
| `ACP_MODEL_CONTEXT_LIMIT` | 覆盖上下文上限。优先级高于配置值。 |
| `ACP_DEBUG` | 设为 `1` 或 `true` 启用 debug 日志。 |

### 压缩策略

模型接收(在其系统提示中)关于**何时**压缩、**逐字保留什么**(路径、签名、错误、决策、用户意图)、**丢弃什么**(冗长日志、重复内容、已消费的探索)的详细指导。这段指导每轮都注入,确保它始终在模型的注意力范围内。

### 哪些内容会被保护

billion-context 保护三类内容不被压缩:

1. **永久保护的工具** — `compress` 调用被硬保护(它们是承载关键元数据的;压缩它们会破坏 decompress 和"摘要是历史"的契约)。
2. **软近期区** — 最后 N 条消息(默认 5)和最后约 5K token 被软保护,让模型保留工作集。来自 `decompress`、`search_context`、`read`、`bash` 的工具结果被**排除**出此区:它们体量大、消费后就该能压缩,所以不该占用保护预算。
3. **最后一条用户消息** — 始终保护(用户意图必须存活)。

## 基于 acp-kernel

压缩引擎是 [`acp-kernel`](https://github.com/ranxianglei/acp-kernel) — 平台无关、MIT 许可的库,有 208 个测试。它被内联打包进 `dist/index.js`,因此零运行时依赖。

## 许可证

MIT.
