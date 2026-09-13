# 研究底稿：Terminal-Bench 4.0 与 Harbor 接入（P3 输入）

> 来源：sol-opencode/apps/bench/tb/（本地克隆）+ Harbor 官方文档（harborframework.com/docs/agents）+ tbench.ai（2026-09-13 检索）。

## 1. TB 4.0 事实
- TB 4.0 **不能用** Laude 的 `terminal-bench` pip 包跑（冻结在 terminal-bench-core v0.1.x，README 引导用户转 Harbor）；正确入口：`harbor run -d terminal-bench/terminal-bench@4.0.0`（数据集仓库 harbor-framework/terminal-bench，tag v4.0.0）。
- 66 题，恰 3 题声明 `gpus=1`（jax-speedrun-gpu / fp8-rmsnorm-gemm / math-eval-grader）→ **63 题 CPU-only**（SoL-OpenCode 逐 task.toml 核验过；sglang-qwen-burst、vllm-deepseek-streaming 听着像 GPU 但 gpus=0，含在内）。
- 4.0 全任务 **flat agent timeout = 8 小时**（tbench.ai 4.0 公告：重校准资源、修 19 题、删 8 题）。
- 任务格式：Harbor task format（task.toml + Dockerfile + verifier 测试）。

## 2. Harbor 自定义 agent（官方 docs/agents 提取）
- 无需改 Harbor 源码；`--agent path.to.module:AgentClass`（dotted import path）即可注册。
- 两种类型：
  - **External**：`BaseAgent`（harbor.agents.base）：name()/version()/setup(environment)/run(instruction, environment, context)，经 environment.exec 发命令。
  - **Installed（本方案采用）**：`BaseInstalledAgent`（harbor.agents.installed.base）+ `@with_prompt_template`：
    - `install(environment)`：`self.exec_as_root(...)` 装系统包；`self.exec_as_agent(...)` 装用户级（以 task.toml 的 agent.user 身份）。
    - `run(instruction, environment, context)`：`self.exec_as_agent(environment, command=...)` 调 agent CLI。
    - `populate_context_post_run(context)`：解析轨迹回填结果（token/usage 从我们自己的 --json 输出取）。
- 配置：`--ak key=value`（或 config=@file / inline JSON）；env 注入：`--ae KEY=VAL`（SoL-OpenCode 用 `--ae OPENCODE_API_KEY=...`，不落日志不经 shell）。
- 结果上报：填 AgentContext；官方轨迹格式 ATIF（可选，不强依赖）。
- 内置参考：`harbor agent list` / `harbor agent schema <name>`。

## 3. SoL-OpenCode 的双臂做法（照抄结构，换 agent）
- 唯一双臂差异 = agent config overlay（control 仅 provider 块；treatment=provider+插件全开）。
- 能力=`verifier_result.rewards.reward`（1.0=solved）；效率=usage tokens + cost_usd（agent 侧解析）。
- held-out 纪律：freeze manifest（源码哈希+配置+split）→ 一次性消费 → append-only ledger → report 只从 ledger 派生；`--probe` 基建检查不烧 one-shot。
- 任务选择：`--include-task-name terminal-bench/<task>` 逐题指定；并发 `-n 4`。

## 4. 本项目 zcode agent 适配设计（P3 依据）
- **ZcodeAgent(BaseInstalledAgent)**：
  - `install()`：容器内装 node（≥22，可用 apt/nvm/静态二进制）→ 拷入 zcode.cjs（从 mac app bundle 或 Linux 构建取——**容器 spike 首任务**：zcode.cjs 是纯 JS esbuild bundle，mac 上系统 node 可跑，Linux 预期同理，实测定论）→ scripts/install-plugin.mjs 安装 sol-zcode 插件（control 臂：装但 plugins.options 全关；treatment 臂：全开）→ 写 `~/.zcode/cli/config.json`（G2 三段式：provider registry + model 字符串；apiKey 经 `--ae ZCODE_BIGMODEL_KEY=...` env 注入，install 时落 config，不进镜像不进日志）。
  - `run()`：`node zcode.cjs --prompt <instruction> --mode yolo --json`（G3/G18：--max-turns/--allowed-tools 坏；超时由 Harbor 任务级控制 + 自管 8h 上限）。
  - `populate_context_post_run()`：解析 --json（usage inputTokens/outputTokens/cacheRead/cacheWrite + sessionId + response）回填 context；异常（非零退出/超时/解析失败）记 exception。
- **双臂**：`--ak zcode_arm=control|treatment` 控制插件开关（或两个 Agent 类）；唯一差异=plugins.options。
- **计量**：主指标 inputTokens（含 cache 分项）、USD（GLM-5.3-Flash 定价表×usage，定价来源注明日期）、墙钟（Harbor job 时间 + agent 级计时）、异常（exit!=0/timeout/无输出）、解题率（verifier rewards）。
- **未决（P3 spike 清单）**：① zcode.cjs 在 Linux node 下可跑性；② harbor 的安装方式（pip 包名/版本，SoL-OpenCode 用 v0.23.0 contained venv）；③ 容器到 open.bigmodel.cn 网络（必要时配代理）；④ orbstack 资源下的并发度上限；⑤ ZcodeAgent 的 exec_as_agent 用户环境（HOME=/home/agent?，插件数据目录落点）。
