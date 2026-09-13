# WORKLOG 2026-09-13 — 研究与 Spike 阶段

## 完成
1. **三源研究落盘**（详见 docs/RESEARCH/）：
   - SoL-Pi 全仓机制规格（含常量、算法、防篡改设计、测试语义）。
   - SoL-OpenCode 移植方案（core 可整体 vendor、适配层重写策略、四层基准方法、已发表数据）。
   - Zcode 插件 API（官方文档 zai-org/zcode-plugins + 运行时反编译 + 官方 example-plugin 交叉）。
2. **Spike 实测**（结论全部进 docs/GOTCHAS.md G1–G15）：
   - headless 公式：cli config.json 的 provider 注册表+model 字符串 → GLM-5.3-Flash 可用。
   - `--json` usage 计量（provider 来源）。
   - 插件 hooks headless 全事件触发；PostToolUse 结构化 tool_response。
   - 原生大输出外置（~2KB 预览+全文落盘）。
   - MCP 握手（server/discover→initialize→tools）与"未请求消息=连接被弃"的坑。
   - JSON permissionDecision deny 被 yolo/edit 无视；**exit-2 硬阻断有效且 stderr=reason**。
   - SessionStart additionalContext 可达模型；UserPromptSubmit continue:false 有效。
   - 插件脚本化安装（spike/install-plugin.mjs，zcode plugins list 认可）。
3. **方案落盘**：docs/DESIGN.md（五机制映射+门控+防篡改+基准设计+偏差声明）、docs/PLAN.md（P0–P4 派单）。

## 决策记录
- D1 架构=MCP 包装工具（sol_write/sol_edit/sol_bash/obs_recall/sol_trajectory）+ hooks 遥测/引导/注入。依据：公共 API 不能改内置 schema/工具结果/历史（docs/RESEARCH/zcode-plugin-api.md §4）。
- D2 硬门用 exit-2（G8）；JSON deny 不可用。
- D3 reducer 模型调用=headless zcode 子进程（凭证/模型归宿主，C4）。
- D4 OCC=候选选择+经济学+建议注入+SessionStart(compact) 提醒（无主动压缩 API，诚实偏差）。
- D5 门控唯一面=plugin userConfig（默认全 false；全关=零行为）。
- D6 账本/轨迹 hash 链 + verify CLI（超出上游强度，满足 C3）。

## 待办
- 方案审核（AUDIT 目录）→ P1 开发。
