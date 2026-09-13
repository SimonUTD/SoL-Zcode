# 待合入文档的新实证（2026-09-13，主控在复审期间的补充 spike；复审返回后合入 DESIGN/GOTCHAS）

## 1. plugins.options 形状（B1 落地依据，已实证）
- 运行时 schema：`options: g.record(g.string(), g.record(g.string(), NAo))`，`NAo = union(string|number|boolean)`。
- 即 `~/.zcode/cli/config.json` 的 `plugins.options = { "sol-zcode@<marketplace>": { "actionFusion": true, "reducerModel": "..." , ... } }`。
- plugin-id 用 `<name>@<marketplace>`（与 enabledPlugins 同键域；canonicalizePluginId 存在，别名 zcode-cua→computer-use 的迁移逻辑旁证该键域）。

## 2. 工具限制旗标实测（M3 落地依据）
- `--allowed-tools <list>`：**坏**（文档有、解析不认，同 G3 --max-turns）。
- `--disallowed-tools "Bash"`：**有效**——模型尝试 echo 被拒，复述"Bash 不可用"。
- 结论：reducer 子进程封工具面改用 `--disallowed-tools` 枚举内置工具名（+隔离 home 使 MCP/插件工具根本不加载）。

## 3. reducer 子进程最终三层防护（升级 DESIGN §2.3）
1. **隔离 ZCODE_HOME**：子进程 env `ZCODE_HOME=$ZCODE_PLUGIN_DATA/run/reducer-home/`，内放仅含 `{provider:<宿主同款>, model:<reducerModel||宿主 model>}` 的 cli config.json（spawn 时从宿主 cli config 程序化拷贝 provider 段——凭据来源仍是 Zcode 自身配置，C4 成立）→ 插件/用户 MCP 完全不加载（也根除重入，aux 标记降级为双保险）。
2. `--disallowed-tools` 内置工具清单（Bash Read Write Edit Glob Grep Agent Task TodoWrite WebFetch WebSearch ... P1 定稿）。
3. `SOL_ZCODE_AUX=1`（hooks/MCP 见之零行为，防宿主行为变化）。

## 4. --attach 实测（M4 落地依据）
- `--prompt "…" --attach /path/log.txt`：模型准确读出附件内容中的标记（SECRET-PAYLOAD-7g9x 测试）→ 大日志走附件通道成立。

## 5. 附带发现
- `--disallowed-tools` 语义即"黑名单"，Claude Code 风格 `Bash(git *)` 规则串支持与否未测（不需要）。
