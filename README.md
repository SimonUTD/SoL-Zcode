# SoL-Zcode

> Porting NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi)'s **five surviving token-efficiency mechanisms** into an independent [ZCode](https://zcode.z.ai/) plugin — public plugin APIs only, explicit opt-in, evidence-preserving.

**English TL;DR** — This repo contains `sol-zcode`, a ZCode plugin that ports the five mechanisms SoL-Pi's automated research retained (action fusion, observation packs, evidence-preserving reducer, online context compaction, trajectory inspector). It uses only public plugin APIs (MCP tools + hooks), is disabled by default until explicitly opted in, keeps every original observation on disk in a tamper-evident hash-chained ledger, and leaves auth / provider URLs / model selection / shell semantics to ZCode. Design was audited to 9.5/10; implementation passed 138 unit/integration tests plus 9 real-model e2e scenarios (including prompt-injection adversarial tests). Terminal-Bench 4 A/B benchmark (GLM-5.3-Flash, plugin off vs on) is in progress — results land in `docs/REPORT.md` when ready. See `docs/DESIGN.md` for the full design and honest deviations list.

## 五种机制

| 机制 | 上游原理 | Zcode 实现 |
|---|---|---|
| **动作融合** Action Fusion | edit/write 可带 `then_run{command,timeout?}`，变异+验证一次调用完成 | MCP 工具 `sol_write` / `sol_edit`（变异语义与内置等价，含 sha256 双读守卫与每文件串行队列） |
| **观察包** Observation Pack | 大型工具结果内容寻址存储，替换为稳定 `obs_<24hex>` 标识符，可精确分页检索 | `sol_bash` 大输出 >10KiB 即归档+占位（头尾 512B 整行摘录），`obs_recall` 字节级分页/搜索召回 |
| **证据保留型约简器** Evidence-Preserving Reducer | 冗长诊断日志仅在每条引用与归档原文**逐字一致**且哈希相符时才简化，否则原文不动 | 诊断命令 ≥4KiB → 归档 → headless zcode 子进程归约（隔离 HOME+工具封禁+aux 防重入三层防护）→ 逐字核验（quote 必须逐字节存在于归档）→ 回执替换；任何失败=原文原样返回（fail-open） |
| **在线上下文压缩** Online Context Compact | 新完成计划步骤成为经济性优化与压力检测候选；优化成功后任务推进并收到提醒 | TodoWrite 边界检测 + 上游经济学公式（1:1 vendor）+ 累积估算器压力检测 + Stop-block 提醒（自限 ≤2/会话 ≤3） |
| **轨迹检查器** Trajectory Inspector | 仅元数据 JSONL：操作/请求/工具使用/结果/压缩信息；不含提示/参数/输出 | 全部 7 个 hook 事件 → hash 链账本（每行 prevHash→hash）；`sol_trajectory` 工具查询；`verify-evidence` CLI 对账任何篡改 |

## 硬约束（全部满足并经审核验证）

- **仅公共插件 API**：MCP server（自定义工具）+ hooks（7 事件）+ manifest；零 npm 运行时依赖（仅 `node:*`）；不 patch 宿主。
- **显式 opt-in**：五机制开关默认全 false（`plugins.options`，见下）；未配置 = hooks 零行为、MCP 工具面为空（e2e 实测零文件零工具）。
- **证据保留**：原文先归档后替换（内容寻址、`O_EXCL`、0600）；账本 append-only + hash 链；`scripts/verify-evidence.mjs` 揭露任何行内改写/中段删插；回执附 `source_artifact` 路径与 readback 指引。
- **宿主管辖权**：身份验证、provider URL、模型选择、shell 行为全部由 Zcode 自身配置决定（归约子进程继承宿主配置，插件不持有任何凭据）。

## 安装

```bash
# 本地安装（开发/测试）
node scripts/install-plugin.mjs plugin sol-zcode-dev --options '{"actionFusion":true,"observationPack":true,"evidenceReducer":true,"onlineCompact":true,"trajectory":true}'
```

或在 ZCode 客户端「发现」页添加本地市场安装。`--options` 为**替换语义**（传 `{}` 即全关）。

## Opt-in 配置

开关写在 `~/.zcode/cli/config.json` 的 `plugins.options["sol-zcode@<marketplace>"]`（客户端插件设置界面保存的就是这里）：

| 键 | 类型/默认 | 说明 |
|---|---|---|
| `actionFusion` / `observationPack` / `evidenceReducer` / `onlineCompact` / `trajectory` | bool / `false` | 五机制独立开关 |
| `actionFusionGate` | bool / `false` | 对原生 Write/Edit 等变异工具 exit-2 硬引导改用 sol_* 工具（默认软引导） |
| `reducerModel` | string / `""` | 归约模型；空 = 继承宿主当前模型（Zcode 决定） |

类型非法的键按 false 处理并记一条 `config_rejected` 轨迹（可诊断 opt-in 拼写错误）。

## 测试

```bash
node scripts/run-tests.mjs          # 138 unit + integration（零模型调用）
node tests/e2e/run-e2e.mjs          # 9 个真模型 e2e 场景（GLM-5.3-Flash，含对抗注入/等价性/fail-open）
node plugin/scripts/verify-evidence.mjs   # 证据完整性对账
```

e2e 亮点：双臂编辑等价（字节级）、观察包分页取回逐字节还原、对抗注入（`rm -rf`/Cron 指令进入归约日志但零副作用）、OCC 真实 1M 窗口经济触发、全关零行为、归档故障 fail-open。

## 与上游的已知偏差（诚实清单）

无历史投影 API → 观察包"首次即占位"（非前 2 次全量）；原生工具大输出不可改写（宿主限制）→ 仅归档+账本；OCC 不能主动触发压缩 → 建议+提醒模式 + 宿主原生 autoCompact 兜底，压缩事后检测在 0.16.5 不可用（G21）；归约走 headless 子进程 → 墙钟代价（LRU 缓解）。完整列表见 `docs/DESIGN.md` §8。

## 仓库结构

```
plugin/            sol-zcode 插件（.zcode-plugin/manifest、mcp/、hooks/、core/ 零依赖 vendor、scripts/verify-evidence）
tests/             unit + integration（138）+ e2e（真模型 9 场景）
scripts/           install-plugin.mjs / run-tests.mjs
benchmark/         Terminal-Bench 4 双臂基准（Harbor 自定义 agent；进行中）
docs/              DESIGN / PLAN / GOTCHAS(G1-G23 宿主行为坑律) / RESEARCH / WORKLOG 审核报告
```

## 质量流程

每个阶段：开发（subagent）→ 独立审核（subagent，带 file:line 证据与 10 分制评分）→ 整改 → 复审，**≥9.5/10 才放行**。审核报告全部落盘 `docs/WORKLOG/AUDIT_*/`：方案 6.5→9.5、P1 9.0→9.5、P2 9.0→9.5。

## 基准（进行中）

Terminal-Bench 4（63 CPU-only 题）× 双臂（control=插件全关 / treatment=五机制全开，唯一差异=plugins.options），GLM-5.3-Flash，Coding Plan 配额消耗，五指标：input tokens、成本（API 牌价折算口径）、墙钟、异常、解题率。探针先行、freeze manifest + append-only ledger + 断点续跑。结果出来后写入 `docs/REPORT.md`。

## 致谢与许可

- 五机制源自 NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi)（MIT）；`plugin/core/` vendor 自 [SoL-OpenCode](https://github.com/ImKK666/SoL-OpenCode) 的零依赖 core（保留 NVIDIA/ImKK666 版权头，见 `plugin/THIRD_PARTY_NOTICES.md`）。
- 本项目 MIT。
