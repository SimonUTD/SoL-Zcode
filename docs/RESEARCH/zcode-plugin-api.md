# 研究底稿：Zcode 插件公共 API（实测 + 官方文档 + 运行时反编译三源交叉）

> 来源：Explore 子代理（2026-09-13，运行时 /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs 0.16.5 反编译 + 官方插件实例）+ zai-org/zcode-plugins 官方文档（docs/PLUGIN_DEVELOPMENT_CN.md）+ 本地 spike 实测（见 GOTCHAS）。冲突处以实测为准。

## 1. 插件形态（官方规范）
- manifest：`<pluginRoot>/.zcode-plugin/plugin.json`，必填仅 `name`（`^[a-z0-9][a-z0-9._-]{0,127}$`）；可选 version/description(+i18n)/author/homepage/repository/license/keywords/组件字段（commands/skills/hooks/mcpServers/agents，可目录名/数组/内联）/dependencies/userConfig。`channels/lspServers/outputStyles/settings` 仅登记不执行。
- 组件：`commands/*.md`（frontmatter description 必填，正文 $ARGUMENTS）；`skills/<n>/SKILL.md`（name/description）；`agents/*.md`；`hooks/hooks.json`（标准位置自动发现，勿在 manifest 重复指向）；`.mcp.json` 或 manifest mcpServers。
- userConfig：`{type: string|number|boolean|directory|file, title, description, default, required, sensitive}`；MCP env 里 `${user_config.KEY}` 引用（敏感项暂不能经界面持久化填写）。
- 环境变量：`ZCODE_PLUGIN_ROOT/ZCODE_PLUGIN_DATA/ZCODE_PLUGIN_ID/ZCODE_PLUGIN_NAME`（命令与 args 模板展开；长期数据写 PLUGIN_DATA，勿写安装目录）。
- 安装（UI 流程）：本地 marketplace.json（plugins[].source 支持相对目录/github/git/directory/file/url/npm）→ 发现页 + 添加 → 获取安装（落 cache + seed + installed_plugins.json + enabledPlugins）。
- 安装（脚本化，实测 G12）：cache 拷贝 + `.zcode-plugin-seed.json{hash,marketplace,plugin,pluginVersion,source:"filesystem",version:1}` + `installed_plugins.json{plugins:[{id:"name@marketplace",installPath,scope:"user",source:路径,cacheTransactionId}]}` + `config.json.plugins.enabledPlugins[id]=true`。
- 校验工具（官方市场仓库）：`python3 scripts/validate.py` / `build_dist.py`（我们的 repo 自带等价校验脚本即可）。

## 2. Hooks 规格（7 事件，插件 hook 随插件启停自动生效）
- 事件：SessionStart(matcher 匹配 source: startup|clear|compact)、UserPromptSubmit(不过滤)、PreToolUse(匹配工具名)、PermissionRequest、PostToolUse、PostToolUseFailure、Stop(不过滤)。无 PreCompact/SubagentStop/SessionEnd/Notification。
- 执行器：`process`（argv，无 shell，仅同步）与 `command`（shell 字符串，async/timeout）。timeoutMs 优先于 timeout(秒)；默认 60000ms / stdout 32768B。快照语义：会话启动时捕获，改动需新会话。顺序 user→workspace→插件。
- stdin：一行 JSON，双命名（snake_case 别名保留）。公共字段 session_id/cwd/transcript_path/permission_mode/hook_event_name + 事件字段（tool_name/tool_input/tool_use_id；PostToolUse 另有结构化 tool_response；Stop 有 last_assistant_message/stop_hook_active）。transcript_path 临时文件，hook 后清理。
- stdout 协议：`{`开头 JSON 才解析；空=无效果。信封 {additionalContext, continue, decision, reason, suppressOutput, systemMessage, hookSpecificOutput}。hookSpecificOutput 按事件判别：PreToolUse{permissionDecision:allow|ask|deny, permissionDecisionReason, updatedInput(全量替换+原 schema 重校验), additionalContext}；PermissionRequest{decision:{behavior:allow|deny, message, updatedInput, updatedPermissions}}；UserPromptSubmit/SessionStart/PostToolUse/PostToolUseFailure/Stop 仅 {additionalContext}。UserPromptSubmit 可 {continue:false,reason} 阻断。Stop 可 {decision:"block",reason} 续跑（≤3 次连续）。
- 退出码：0=成功解析 stdout；**2=阻断快捷方式**（可阻断事件产生 block/deny，Stop 产生续跑）；其他=可恢复失败。
- ⚠️ 实测修正（G8/G9/G10）：JSON permissionDecision deny 在 yolo/edit 被无视；**exit-2 硬阻断有效且 stderr 文本作为 reason 回传模型**；SessionStart additionalContext 注入可达模型；UserPromptSubmit continue:false 有效。

## 3. MCP server 规格
- stdio：`command/args/cwd/env/enabled/timeoutMs(默认30000)`；http/sse：url/headers。命名空间 `plugin:<插件名>:<服务名>`，工具暴露为 `mcp__<服务名>__<工具名>`。未知顶层键整个 server 被丢弃。模板变量仅插件 MCP 展开。
- 帧：每行一条 JSON-RPC（非 LSP Content-Length）。握手（实测 G11）：`server/discover`（回 `{supportedVersions:[...], capabilities:{tools:{}}}`）→ `initialize`（回 protocolVersion/capabilities/serverInfo）→ `notifications/initialized`（不回）→ `tools/list`（回 `[{name,description,inputSchema}]`）→ `tools/call`（回 `{content:[{type:"text",text}],isError?}`）。绝不主动发消息。
- 官方参考实现：`zcode-plugins/plugins/example-plugin/mcp/hello-server.mjs`（零依赖）。

## 4. 能力边界结论（本项目架构依据）
| 诉求 | 结论 | 依据 |
|---|---|---|
| 给内置 Edit/Write 加参数 | ❌ updatedInput 须过原 schema 重校验 | 官方文档 §4.6 + 运行时 lne() 校验路径 |
| 改写工具结果（大输出→占位符） | ❌ PostToolUse 无改写键 | 官方文档 §4.1"不能替换工具输出" |
| 改写历史上下文/触发压缩 | ❌ 无公共 API；仅 additionalContext 注入 + 原生 autoCompact(autoCompactThreshold 运行时存在) + /compact 用户命令 | 官方文档 §4.1 + 运行时 grep |
| 注册自定义工具（任意 schema） | ✅ MCP tools/list inputSchema | 实测（sol_spike_echo 被模型调用成功） |
| 硬阻断工具调用并回传 reason | ✅ PreToolUse hook exit 2（stderr=reason） | 实测 G8 |
| 会话开始注入模型可见指引 | ✅ SessionStart additionalContext | 实测 G9 |
| 追加 JSONL 遥测 | ✅ 任意 hook 落盘 | 实测（spike dumps） |
| headless 驱动 + 计量 | ✅ `--prompt --mode yolo --json`（usage 来自 provider） | 实测 G4 |

## 5. 其他
- 用户级 hooks 配置 `~/.zcode/cli/config.json` 须 `hooks.enabled:true`；**插件 hook 无需此开关**（随插件启停）。
- 会话/遥测数据源：`~/.zcode/cli/rollout/model-io-sess_*.jsonl`（逐请求完整 IO，留存受 modelIoFullRetentionEnabled 影响）；`~/.zcode/cli/agents/sess_*/transcript.jsonl`；`~/.zcode/cli/artifacts/sess_*/`（工具结果外置）；`~/.zcode/cli/exec/sess_*/call_*-stdout.log`（Bash 全文）。
- 模型目录：GLM-5.3-Flash 在 `builtin:bigmodel-coding-plan`（v2/config.json 实证，含 reasoning variants low/high/max）。
- ZCODE_HTTP_PROXY 用于市场克隆代理。
