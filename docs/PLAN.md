# PLAN — 开发计划与派单（v1，待审）

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
- **范围**：`plugin/**`、`tests/**`（除 e2e 真模型）、`scripts/**`。允许读 `sol-opencode/packages/core/**`、`docs/**`、`spike/**`。
- **文件边界（可写）**：`plugin/`、`tests/unit/`、`tests/integration/`、`scripts/`。禁止改 `docs/`、`SoL-Pi/`、`sol-opencode/`、`zcode-plugins/`、`benchmark/`、`spike/`。
- **禁止事项**：引入任何 npm 运行时依赖（零依赖 node:*）；把密钥/绝对家目录写死；修改用户 `~/.zcode/**`（安装动作只经 scripts/install-plugin.mjs 且只在明确要求时执行）；占位符/TODO 交差。
- **必做**：
  1. vendor core：从 `sol-opencode/packages/core/src` 逐文件移植为 ESM `.mjs`（保留 NVIDIA 版权头 + THIRD_PARTY_NOTICES.md），类型擦除不改算法；`plugin/core/` 下。
  2. manifest + userConfig（默认全 false）+ `.mcp.json`（env 注入 `${user_config.*}`）。
  3. hooks：`hooks/hooks.json`（7 事件挂单脚本 `hooks/sol-hook.mjs <Event>`，process 型）+ 配置解析 lib（从 env 读开关，非法回退 false）。
  4. MCP server：握手序列按 GOTCHAS G11；工具 sol_write/sol_edit/sol_bash/obs_recall/sol_trajectory；五机制按 DESIGN §2 实现；全部 fail-open。
  5. 证据存储 + hash 链账本 + `scripts/verify-evidence.mjs`。
  6. `tests/unit/`（core 断言等价移植）+ `tests/integration/`（MCP 握手/hook fixture/verify CLI 篡改检测/全关零行为）。
- **期望输出**：证据化摘要（文件清单+测试命令+结果计数+关键行号）。
- **验收门**：`node --test tests/` 全绿；审核 subagent ≥9.5。

## P2 派单（dev subagent B）
- **范围/边界（可写）**：`tests/e2e/**`、`scripts/e2e-*.mjs`、`fixtures/**`；只读其余。
- **必做**：隔离 HOME 的 headless 真模型 e2e（G2 公式；场景断言见 DESIGN §6.3）；每场景产出 sessionId+usage+断言结果到 `tests/e2e/results/`；异常场景（模型不配合/工具误用）的 fail-open 证明。
- **验收门**：e2e 全绿 + 审核 ≥9.5。

## P3 派单（dev subagent C）
- **范围/边界（可写）**：`benchmark/**`；只读 `plugin/`、`docs/`。
- **必做**：zcode Linux 容器化（Dockerfile + 镜像内插件安装 + 凭据经 env 注入不落盘）；TB4 任务集获取与任务清单核对（63 题排除 GPU，落 manifest）；双臂 runner（交错、并发 ≤4、超时控制、--json 计量+verifier 结果采集、append-only ledger、freeze manifest）；3 题探针跑通 → 全量 63×2。
- **验收门**：探针 ledger 有真实数据；全量完成或明确记录中断原因；成本/时间预算表。

## P4 派单（dev subagent D）
- **范围/边界（可写）**：`README.md`、`README_CN.md`、`docs/REPORT.md`、`.gitignore`、git 提交与推送（origin main）。
- **必做**：对照表（五指标 双臂）；与 SoL-Pi/SoL-OpenCode 已发表数据的口径对照（明确不同口径）；偏差声明（DESIGN §8）；git 历史整洁（分阶段提交）。
- **验收门**：GitHub 推送成功；报告含 inputTokens/USD/墙钟/异常/解题率五项。

## 风险与预案
| 风险 | 预案 |
|---|---|
| zcode Linux 版获取失败 | 备选：macOS 宿主直跑 zcode、容器只承载任务环境与 verifier（TB4 agent 以"remote"方式执行）；再备选：OrbStack macOS VM 跑 mac 构建 |
| 全量 63×2 时间/成本超限 | 先探针校准 → 降并发窗口外时间运行；不行则分层子集（同难度带抽样）+ 诚实标注 |
| headless 会话行为与 TUI 不一致 | 所有 e2e/bench 均用 headless（与 TB4 环境一致），报告注明 |
| exit-2 硬门影响解题率 | gate 默认 false；基准 treatment 主配置不含 gate（只用引导），gate 作为附加消融选项 |
| reducer 子进程成本失控 | LRU + 90s 超时 + 每会话 reducer 调用上限（默认 8 次，防退化循环） |
