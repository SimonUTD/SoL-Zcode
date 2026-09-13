# GOTCHAS — Zcode 宿主行为坑律（全部经 2026-09-13 实测验证）

> 每条附验证方式。改版（zcode.cjs 0.16.5 / ZCode.app 3.11.2）后须重验。复现脚本在 `spike/`。

## G1. Zcode 没有独立 CLI，只有 app 内的 zcode.cjs
- 事实：唯一可执行入口 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（0.16.5，esbuild 单文件，Node ≥25 可跑）。用户 明确：无独立 CLI 产品。
- 影响：一切自动化测试必须 `node zcode.cjs ...` 方式驱动。
- 验证：`node <path> version` → `0.16.5`。

## G2. headless 模型配置的坑：三段式才生效
- 事实：`--prompt` headless 报 "Model config is missing"，`~/.zcode/cli/config.json` 必须同时有：
  1. `provider` 注册表（对象，含 kind/options.apiKey/options.baseURL/models）——可直接从 `~/.zcode/v2/config.json` 的 `builtin:bigmodel-coding-plan` 条目拷贝（app 已登录的凭据）；
  2. `model` 字符串 `"builtin:bigmodel-coding-plan/GLM-5.3-Flash"`（或 `{main:{provider,...}}` 对象，但对象内联 baseURL/apiKey 的形式会报 missing，**字符串+provider 表**才是可行组合）。
- 已验证 GLM-5.3-Flash 在 `builtin:bigmodel-coding-plan` 的 models 里存在且可调用（rollout `body.model = GLM-5.3-Flash`）。
- 原始 cli config 备份：`/tmp/cli-config-backup.json`。
- 影响：凭据/模型归宿主（app 的配置），符合任务约束"身份验证、URL、模型由 Zcode 决定"。

## G3. `--max-turns` 是坏的
- 事实：help 文本里有 `--max-turns <n>`，但解析器报 `Unknown option '--max-turns'`（`--maxTurns`/`--max-turns=8` 同样拒绝）。
- 影响：headless 不能用该旗标限轮；靠 prompt 约束与 `--json` 结果判断。

## G4. headless `--json` 是计量金矿
- 事实：`node zcode.cjs --prompt "..." --mode yolo --json` 输出：sessionId/traceId/turnId/response/**usage**（inputTokens/outputTokens/cacheRead/cacheWrite/modelRequestCount，source=provider）/projection（contextUsed/contextWindow）。
- 影响：基准的 tokens/成本计量直接取此处；成本 USD 由 usage × 官方定价表计算。

## G5. 插件 hooks 在 headless 全事件触发；payload 双命名
- 事实：SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop 全部在 `--prompt` 模式触发；stdin JSON 同时含 snake_case 与 camelCase（`tool_name`/`toolName`、`tool_response`/`toolResponse`），另有 traceId/turnId/timestamp/toolCallId/toolResultPreview/transcriptPath。
- `transcript_path` 指向临时文件，hook 结束后宿主会清理——**不可当持久存储**（官方文档 §4.5 明示）。

## G6. PostToolUse 拿到结构化 tool_response（含截断与落盘信息）
- 事实：Bash 的 tool_response = `{stdout, stderr, exitCode, interrupted, timedOut, stdoutTruncated, stderrTruncated, stdoutBytes, stderrBytes, rawOutputPath, persistedOutputPath, persistedOutputSize, ...}`。大输出时 hook 里 stdout 也被截到 30000 字符，但 `persistedOutputPath` 指向全文（108894B 实测）。
- 影响：观察包/约简器的"归档全文"可直接读 persistedOutputPath；若缺失再退回 stdout。

## G7. Zcode 原生就有大输出外置（观察包的现实土壤）
- 事实：Bash 输出 106KB 时模型只见 ~2KB 头部预览 + "full output saved to: <path>"；全文落盘 `~/.zcode/cli/exec/sess_*/call_*-stdout.log`。
- 影响：插件观察包的增量价值 = 稳定 obs id + 头尾摘录（优于只有头）+ 分页/搜索召回 + 账本。

## G8. 【最大坑】PreToolUse 的 JSON `permissionDecision:"deny"` 在 yolo/edit 模式被无视
- 事实：hook 输出 `{"hookSpecificOutput":{hookEventName:"PreToolUse",permissionDecision:"deny",...}}` 后 Write 照样执行成功（yolo 与 edit 模式各实测一次；去掉 process.exit 截断问题后仍被无视）。
- **workaround（已验证有效）**：hook 以 **exit code 2** 退出 → 硬阻断，且 **stderr 文本会作为 reason 回传给模型**（模型明确复述了被拦与原因）。yolo 模式下也有效。
- 影响：动作融合的"重定向门"必须用 exit-2 方案；exit-2 的 reason 走 stderr（上限 ~4KB）。

## G9. SessionStart 的 additionalContext 注入确认可达模型（startup 源）
- 事实：SessionStart hook 返回 `{"hookSpecificOutput":{hookEventName:"SessionStart",additionalContext:"SOLCTX9X7..."}}`，模型对"是否看到 SOLCTX9X7"回答 YES，且 rollout 请求体中出现 1 次。
- 影响：opt-in 启用时的工具使用引导（让模型优先用 sol_write/sol_bash）走此通道。
- 反例：UserPromptSubmit 的 additionalContext 一次实测模型称未见——但审核（运行时反编译）发现 `injectHookAdditionalContextIntoMessageHistory(on.UserPromptSubmit,…)` 是真实注入点（4 个调用点之一），矛盾**未决**，P2 复检后修正本条；当前设计不依赖该通道。
- ⚠️ **SessionStart(compact) 不存在**（审核 M1 反编译证据：runSessionStartHooks 仅 startup/resume 两个调用点；原生/手动压缩不触发任何 SessionStart hook；官方文档 matcher 表"startup|clear|compact"与 0.16.5 实际行为不符）。涉及压缩后事件的机制不得依赖此源。

## G16. hooks 的 command/args 不支持 ${user_config.*} 展开（审核 B1 反编译证据）
- 事实：hook 执行器 `$V` 正则仅 11 个环境变量（CLAUDE_/ZCODE_ PLUGIN_ROOT/PLUGIN_DATA/PROJECT_DIR/SESSION_ID/SKILL_DIR）；user_config 展开器只用于插件 MCP 配置；hook 条目 schema 无 env 字段；运行时无 ZCODE_USER_CONFIG_* 注入（官方 example-plugin 的 session-start.mjs 读该变量，运行时从不设置）。
- 影响：插件 hooks 的配置只能自取：解析 `~/.zcode/cli/config.json` 的 `plugins.options[<plugin-id>]`（运行时键 PluginsOptions；UI 保存 userConfig 即写此处；键格式 P1 实证回填）。
- 关联：G12 安装脚本写同一文件 → 配置与安装同一通道。

## G17. Stop 的 additionalContext 只有在 decision:block 时才会注入模型（审核 M2 反编译证据）
- 事实：Stop additionalContext 的注入点在 shouldContinueAfterStopHooks 分支内；非 block 的 Stop additionalContext 无消费者（被丢弃）。
- 影响：任何"Stop 时给模型捎话"的设计必须用 `{"decision":"block","reason":...}`（连续上限 3 次）。

## G18. headless 旗标补充（CLI --help 实证，审核提示）
- `--allowed-tools <list>`（headless 工具白名单）、`--disallowed-tools <list>`（黑名单）、`--attach <path>`（本地文件附给 --prompt，可重复）、`--settings <path>`（指定 settings 文件）。reducer 子进程封工具面与传大日志的现成手段。

## G10. UserPromptSubmit `continue:false` 阻断有效
- 事实：返回 `{"continue":false,"reason":"..."}` 后请求被拦，stdout 打印 reason。可用于"未 opt-in 却检测到危险配置"的防呆（当前设计不使用，仅备案）。

## G11. 插件 MCP server 握手顺序（新版协议）
- 事实：zcode 先发 `server/discover`（id=server-discover-probe-*，协议 2026-07-28），须回 `{supportedVersions:[], capabilities:{tools:{}}}`；随后 `initialize`（2025-11-25）→ `notifications/initialized` → `tools/list` → `tools/call`。
- 坑：首版 spike server 在收到任何请求前就主动向 stdout 写了一条 id:null 的 initialize 响应——该"未请求消息"疑似导致客户端放弃连接、工具不注册（修掉+补 discover 后正常）。
- 规则：**绝不主动写消息，只应答**；每行一条 JSON-RPC（非 LSP Content-Length 帧）。

## G12. 插件脚本化安装（无 UI）可行
- 事实：拷贝插件目录到 `~/.zcode/cli/plugins/cache/<marketplace>/<name>/<version>/` + 写 `.zcode-plugin-seed.json`（hash/marketplace/plugin/pluginVersion/source:"filesystem"/version:1）+ `installed_plugins.json` 追加条目 + `config.json` 的 `plugins.enabledPlugins["name@marketplace"]=true`，`zcode plugins list` 即可识别（skills/commands/hooks/mcp 计数正确）。脚本：`spike/install-plugin.mjs`。
- hook/MCP 配置在会话启动时快照，改动需新会话（官方文档 §4.2）。

## G13. Node hook 脚本不要 write 后立即 process.exit
- 事实/惯例：管道 stdout 异步，`process.stdout.write` 后立刻 `process.exit(0)` 可能截断输出（G8 排查时先修掉的一个变量）。官方示例不 exit，自然结束。

## G14. headless 会话的 rollout 计量文件会生成但不要依赖其完整性
- 事实：headless 运行产生 `~/.zcode/cli/rollout/model-io-sess_<id>.jsonl`（含 request.body.messages/system/tools 与 response），但 `modelIoFullRetentionEnabled=false`（v2 setting.json）时留存策略不保证完整。
- 影响：基准主计量用 G4 的 `--json` usage（provider 来源），rollout 只作对账/调试。

## G15. 环境事实
- Docker 由 OrbStack 提供（macOS）；代理 `127.0.0.1:7890`（git clone GitHub 需要时用）；gh 已认证 SimonUTD（repo 权限）。
- 官方插件市场源码与规范：`zai-org/zcode-plugins`（已克隆到 `./zcode-plugins/`，文档 `docs/PLUGIN_DEVELOPMENT_CN.md`）。
- 参考实现已克隆：`./SoL-Pi/`（上游）、`./sol-opencode/`（OpenCode 移植，core 包零依赖可 vendor）。
