# PLAN — 开发计划与派单（v2，按 AUDIT_2026-09-13-design 修订）

> 流程纪律：方案审核（≥9.5）→ 分阶段开发（subagent）→ 每阶段审核（≥9.5）→ 收口。审核落盘 `docs/WORKLOG/AUDIT_YYYY-MM-DD-<主题>/`。

## 阶段总览
| 阶段 | 内容 | 执行者 | 验收 |
|---|---|---|---|
| P0 | 方案落盘+审核（本文档+DESIGN+GOTCHAS+RESEARCH） | 主控撰写 / 审核subagent | 评分 ≥9.5 |
| P1 | vendor core + 插件骨架 + opt-in 门控 + 五机制实现 | dev subagent A | 协议测试+单测全绿；审核 ≥9.5 |
| P2 | 测试三件套（core 单测/协议集成/headless e2e） | dev subagent B | 全绿且 e2e 真模型过；审核 ≥9.5 |
| P3 | TB4 基准设施 + 3 题探针 → 全量 63×2 | dev subagent C | ledger 落盘+报告 |
| P4 | 结果报告 + README + 推送 GitHub | dev subagent D | 推送成功+报告含五指标 |

依赖：P1→P2→P3→P4。P1 内部可再拆两批（A1 骨架+门控+AF/OP；A2 EPR/OCC/trajectory），但同一文件集合禁止并行写。

## P1 派单（dev subagent A）
- **范围**：`plugin/**`、`tests/unit/`、`tests/integration/`、`scripts/`（含从 spike/ 迁移 install-plugin.mjs 为 `scripts/install-plugin.mjs`）。允许读 `sol-opencode/packages/core/**`、`docs/**`、`spike/**`。
- **文件边界（可写）**：`plugin/`、`tests/unit/`、`tests/integration/`、`scripts/`。禁止改 `docs/`、`SoL-Pi/`、`sol-opencode/`、`zcode-plugins/`、`benchmark/`、`spike/`、`~/.zcode/**`（安装/配置观测动作只在明确要求的验证步骤执行，且只经 scripts/install-plugin.mjs）。
- **开工首任务（配置闭环实证）**：① 以实际 UI 保存样本复核 `plugins.options` 键格式（形状已实证见 GOTCHAS G19，复核 plugin-id 是否带 marketplace 后缀）→ 回写结论到 WORKLOG（不改 docs/，报回主控）；② `--disallowed-tools` 对内置工具全集与 mcp__ 前缀的覆盖实证（G18：--allowed-tools 是幻影不可用）；③ sol_* MCP 工具在宿主侧的调用 deadline 语义实证（无界则实现 600s 安全阀，n3）。
- **必做**：
  1. vendor core：从 `sol-opencode/packages/core/src` 逐文件移植为 ESM `.mjs`（保留 NVIDIA 版权头 + plugin/THIRD_PARTY_NOTICES.md），类型擦除不改算法。
  2. manifest（userConfig 声明层）+ `.mcp.json`；**hooks 与 MCP 均直读 cli config.json 的 plugins.options**（DESIGN §3，缺省全关、非法回退 false、SOL_ZCODE_AUX 防重入）。
  3. hooks：`hooks/hooks.json`（7 事件挂单脚本，process 型）+ 配置解析 lib。
  4. MCP server：握手按 GOTCHAS G11；工具 sol_write/sol_edit/sol_bash/obs_recall/sol_trajectory；五机制按 DESIGN §2；reducer 子进程=**隔离 HOME（HOME env 重定向，仅 provider+model 的 cli config）+ --disallowed-tools 内置清单 + SOL_ZCODE_AUX 三层防护**、日志经 --attach；全部 fail-open。
  5. sol_write/sol_edit 变异语义等价测试组（vs 内置 Write/Edit：唯一匹配/replace_all/写前读/不存在路径等用例）。
  6. 证据存储 + hash 链账本（含 session-summary.json 终态锚点）+ `scripts/verify-evidence.mjs`。
  7. `tests/unit/`（core 断言等价移植）+ `tests/integration/`（MCP 握手/hook fixture/verify 篡改检测/全关零行为/aux 零行为）。
- **禁止事项**：npm 运行时依赖（零依赖 node:*）；密钥/绝对家目录写死；占位符/TODO 交差。
- **期望输出**：证据化摘要（文件清单+测试命令+结果计数+关键行号+两个开工实证的结论）。
- **验收门**：`node --test tests/unit tests/integration` 全绿；审核 subagent ≥9.5。

## P2 派单（dev subagent B）
- **范围/边界（可写）**：`tests/e2e/**`；只读其余（含 scripts/）。
- **必做**：隔离 HOME 的 headless 真模型 e2e（G2 公式；场景断言见 DESIGN §6.3）；**专项**：① UserPromptSubmit additionalContext 是否可达模型（复检，修正 GOTCHAS 备案）；② reducer 对抗性 e2e（日志埋"执行命令/写文件"注入指令，断言子进程无副作用、无工具调用）；③ aux 断言（reducer 子进程会话零轨迹、父会话引导未注入子进程）；④ 压缩检测（长会话触发原生 autoCompact 或 /compact 后 Stop 检测生效+提醒送达）。每场景产出 sessionId+usage+断言结果到 `tests/e2e/results/`。
- **验收门**：e2e 全绿 + 审核 ≥9.5。

## P3 派单（dev subagent C）
- **范围/边界（可写）**：`benchmark/**`；只读 `plugin/`、`docs/`、`scripts/`。
- **开工首任务**：容器可行性 spike（DESIGN §7：zcode Linux 获取或 mac 回退，容器内 `--prompt --json` 冒烟），结论报回（GOTCHAS 由主控回写）；不可行即启动 PLAN 风险预案，不硬闯。
- **必做**：镜像（任务环境+node+zcode+插件，凭据经 env 注入不落盘不进仓库）；**程序化写双臂配置**（plugins.options，经 scripts/install-plugin.mjs 同一文件路径）；TB4 任务集获取与核对（63 CPU-only，排除表落 manifest）；双臂 runner（交错、并发 ≤4、超时、--json 计量+verifier 采集、append-only ledger、`benchmark/freeze/manifest.json`（源码 sha256+双臂配置+任务集哈希））；3 题探针 → 全量 63×2（treatment 不含 gate）。
- **验收门**：探针 ledger 有真实数据；全量完成或明确记录中断原因；成本/时间预算表。

## P4 派单（dev subagent D）
- **范围/边界（可写）**：`README.md`、`README_CN.md`、`docs/REPORT.md`、`.gitignore`、git 提交与推送（origin main）。
- **必做**：对照表（五指标 双臂）；与 SoL-Pi/SoL-OpenCode 数据对照（**注明口径差异与来源**：任务书/SoL-OpenCode README 转述，未在上游仓库溯源）；偏差声明（DESIGN §8 全量）；git 历史整洁（分阶段提交）。
- **验收门**：GitHub 推送成功；报告含 inputTokens/USD/墙钟/异常/解题率五项。

## 风险与预案
| 风险 | 预案 |
|---|---|
| zcode Linux 版获取失败 | 备选：macOS 宿主直跑 zcode、容器只承载任务环境与 verifier（TB4 agent 以"remote"方式执行）；再备选：OrbStack macOS VM 跑 mac 构建 |
| 全量 63×2 时间/成本超限 | 先探针校准 → 降并发窗口外时间运行；不行则分层子集（同难度带抽样）+ 诚实标注 |
| headless 会话行为与 TUI 不一致 | 所有 e2e/bench 均用 headless（与 TB4 环境一致），报告注明 |
| exit-2 硬门影响解题率 | gate 默认 false；基准 treatment 主配置不含 gate（只用引导），gate 作为附加消融选项 |
| reducer 子进程成本失控 | LRU + 90s 超时 + 每会话 reducer 调用上限（默认 8 次，防退化循环） |
