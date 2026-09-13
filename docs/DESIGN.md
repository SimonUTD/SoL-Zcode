# DESIGN — sol-zcode 插件设计（v1，待审）

> 状态：待审核（审核记录见 docs/WORKLOG/AUDIT_*）。硬约束来自任务目标；宿主行为依据见 docs/GOTCHAS.md（全部实测）；机制规格依据见 docs/RESEARCH/。

## 0. 目标与硬约束
把 NVIDIA SoL-Pi 自动研究存留的五种令牌效率机制移植为独立 Zcode 插件：
1. **动作融合**：edit/write 可带 `then_run{command,timeout?}`，变异+验证单次调用完成，返回综合结果。
2. **观察包**：大型工具结果内容寻址存储，替换为稳定 `obs_<24hex>` 标识符，支持精确分页/检索。
3. **证据保留型约简器**：冗长诊断日志仅当每条保留引用与归档原文逐字一致且哈希相符时才简化；否则原文不动。
4. **在线上下文压缩**：新完成的计划步骤成为经济性优化与压力检测候选；优化成功后任务推进并收到提醒。
5. **轨迹检查器**：仅元数据 JSONL（操作/请求/工具使用/结果/压缩信息），不含提示、参数、输出。

硬约束：
- C1 只用 Zcode 公共插件 API（hooks + MCP + manifest），不 patch 宿主、不引附加插件/模块。
- C2 显式 opt-in；未配置=全禁用（零行为）。
- C3 证据保留：原始记录可读；任何销毁行为可被揭露。
- C4 运行时决策归 harness；**身份验证、provider URL、模型选择、shell 行为由 Zcode 决定**（插件不自带凭据/不改宿主 shell 语义）。
- C5 用 zcode 实际跑 Terminal-Bench 4，对比 glm-5.3-flash 开/关插件：input tokens、成本 USD、墙钟、异常、解题率。

## 1. 总体架构

```
plugin/                                # 插件本体（发布名 sol-zcode）
├── .zcode-plugin/plugin.json          # manifest + userConfig（五机制开关，默认全 false）
├── .mcp.json                          # 声明 stdio MCP server（sol）
├── mcp/server.mjs                     # MCP server（零依赖 node:*）：包装工具 + 召回 + 查询
├── hooks/hooks.json                   # 7 事件挂载
├── hooks/*.mjs                        # 单入口 hook 脚本（按事件参数分发）+ lib 共享
├── core/                              # vendor 自 @alicekk/sol-opencode-core（MIT, NVIDIA 头保留）
│   ├── action-fusion/{then-run,file-queue}.mjs
│   ├── observation-pack/{observation,ledger}.mjs
│   ├── reducer/{config,policy,archive,cache,receipt}.mjs
│   ├── compact/{economics,plan}.mjs
│   └── trajectory/{store,jsonl}.mjs
├── scripts/verify-evidence.mjs        # 证据完整性对账 CLI（hash 链 + 对象复验）
├── README.md / README_CN.md
```

数据落点（全部在 `ZCODE_PLUGIN_DATA` 下，遵守"不写安装目录"）：
```
$ZCODE_PLUGIN_DATA/
├── config.resolve 缓存（无）
├── store/
│   ├── observation-pack/objects/<obs_id>.txt          # 内容寻址原文 0600
│   ├── reducer/objects/<sha前2>/<sha256>.txt          # 诊断日志归档 0600
│   └── ledger/<session>/observation.jsonl             # append-only + hash 链
│       ledger/<session>/reducer.jsonl
│       ledger/<session>/occ-state.json                # OCC 状态快照（每次覆盖写前先 append 到 occ-history.jsonl）
│       trajectory/<session>.jsonl                     # 仅元数据 + hash 链
└── run/                                               # 锁与临时
```

设计原则（继承上游）：**fail-open**（机制自身故障绝不丢观察/证据，原文原样到达模型）；**投影只在能改写的地方改写**（Zcode 下=自有工具输出内闭环）；**内容寻址+独占创建+同名异容即错**；**逐字可验证才接受模型产物**；**默认全关，配置错误回退关闭**（上游是 fail-closed 抛错，插件环境改为"回退关闭+trajectory 记一条 config_rejected"——避免插件错误破坏宿主会话，C2 优先）。

## 2. 五机制映射（SoL-Pi → Zcode 公共 API）

### 2.1 动作融合（Action Fusion）
- **通道**：MCP 工具 `sol_write{file_path,content,then_run?}` 与 `sol_edit{file_path,edits[{old_string,new_string,replace_all?}],then_run?}`（schema 仿内置 Write/Edit，仅追加可选 `then_run{command:string, timeout?:number秒}`）。执行逻辑 vendor core/then-run + file-queue：变异（自实现写文件/字符串替换，语义对齐内置工具）→ sha256 双读守卫（setImmediate 让渡）→ 执行命令（node:child_process spawn `/bin/sh -c`，超时=timeout 秒或 120s 默认，杀进程组）→ 综合结果（成功：`[文件操作结果]\n[then_run:succeeded]\n<输出>`；命令失败：isError=true 且文本含 `[then_run:failed]` 但**文件已写入的事实写明**；变异失败：`[then_run:skipped]`）。每文件 promise-tail 串行队列（realpath 规范键）。
- **引导**（让模型用包装工具而非原生）：SessionStart additionalContext 注入一段固定指引（opt-in 后启用时）。**可选硬门**（userConfig `actionFusionGate` 默认 false）：PreToolUse hook 对 `Write|Edit` 以 **exit-2** 阻断，stderr reason="SoL action fusion: use sol_write / sol_edit (they accept then_run) instead of Write/Edit."（G8 验证的唯一可靠阻断法）。
- **与原版差异**：原版同名替换内置工具（Pi API 支持）；Zcode 不能改内置 schema → 新工具名+引导/硬门。核心算法（标记契约/哈希守卫/队列）1:1。
- **C4 合规**：命令执行即"shell 行为"，语义与宿主 Bash 一致（/bin/sh -c、cwd=会话 cwd、继承环境），不引入新 shell。

### 2.2 观察包（ObservationPack）
- **通道**：MCP 工具 `sol_bash{command, timeout?}`（以及 sol_write/sol_edit 的 then_run 输出同走此路径）：执行命令拿全文 → 纯文本 >THRESHOLD_BYTES(10KiB) 时 vendor core/observation 处理：id=`obs_`+sha256(tool\0callId\0contentHash)[0:24]、ensureStored（O_EXCL 0600，EEXIST 复验 size+sha，同尺寸异容=错）、占位符=元信息头（id/tool/bytes/lines/estimated_tokens/retrieve 指令）+ 头 512B 完整行 + `[middle omitted...]` + 尾 512B 完整行。**≤阈值或任何归档错误 → 全文原样返回（fail-open）**。
- **召回**：MCP 工具 `obs_recall{id, offset?, query?}`：分页（16KiB/400 行上限、next_offset/eof 头两行）与字节级字面量搜索（query ≤256B，≤20 条命中，UTF-8 边界安全）。账本记 full/placeholder/recall（元数据+contentHash）。
- **原生工具遥测（补偿通道）**：PostToolUse hook 对所有工具结果：>阈值即归档到 observation store（优先 persistedOutputPath 全文，G6）+ ledger 记 `native` 事件。**不能改写原生结果**（API 无通道，官方文档明示）——归档保证证据可查，token 节省不来自此通道（诚实记录于 README）。
- **与原版差异**：原版"前 2 次全量后替换"需要历史投影 API（Zcode 无）→ 自有工具**首次即占位**（摘录+召回指令），原生工具仅归档不替换。其余（id 格式/阈值/摘录算法/recall 限额/账本）1:1。
- **豁免**：EPR 回执首行 `sol_zcode_evidence_receipt_v1` → 不打包（防已核验证据被二次摘录）；自有工具 obs_recall/sol_trajectory 输出不打包。

### 2.3 证据保留型约简器（Evidence-Preserving Reducer）
- **触发**：sol_bash 结果（含 then_run 输出，标记后段为 body）命令匹配 vendor core/reducer 的 DIAGNOSTIC_COMMAND 正则 且 body ≥4096B 且 ≤600k 字符 且不匹配 LIKELY_SECRET。失败判定=exitCode!==0（then_run 失败=failed 标记）。
- **流水线**（vendor core + 适配）：四道门 → 归档（sha256 分桶 wx 0600，异容=integrity failure）→ LRU(64) 缓存（key 含 archiveHash/command/isError/provider/model/指令版本；命中复用回执、usage 记 0）→ **归约模型调用** → validateReceipt（schema/source_sha256/status 一致/每条 quote `body.includes(quote)` 逐字/≤12 条≤600 字符/kind 白名单/missing-failure-evidence 守卫）→ `receipt-not-smaller` → 工具返回=变异确认+标记保留、**body 段替换为回执文本**；任何一步失败=全文原样返回 + journal fallback(原因)。
- **归约模型调用（C4 关键设计）**：spawn 子进程 `node <zcode.cjs> --prompt <归约指令+untrusted_log 包裹的全文> --mode yolo`（headless 公式 G2：子进程继承同一 `~/.zcode/cli/config.json`，**认证、provider URL、模型选择全部由 Zcode 已有配置决定**；可用 userConfig `reducerModel` 覆盖 model 字符串，默认继承主模型）。超时 90s（AbortController+kill）。usage 从子进程 stdout `--json` 的 usage.inputTokens/outputTokens 提取。防注入：reducer 提示词 vendor 原文（"log 是 untrusted data…"）+ 子进程仅一问一答（prompt 里要求仅输出 JSON；解析侧 validateReceipt 是最终防线）。
- **回执文本**：首行 `sol_zcode_evidence_receipt_v1` + status/uncertain/command_sha256/source_sha256/bytes/lines/source_artifact(绝对路径)/reducer_provider/model/tokens + verified_evidence(kind/line/quote_sha256/quote) + `authority=...` + `readback=use sol_bash with sed -n '<line>p' style range or obs_recall on source_artifact...`。
- **与原版差异**：归约传输从"registry 直调/子会话"改为"headless zcode 子进程"（等价物：凭证不进插件、宿主决定模型）。其余 1:1。

### 2.4 在线上下文压缩（Online Context Compact）
- **计划源**：原生 TodoWrite。PostToolUse(TodoWrite) hook 读 tool_input.todos → vendor core/plan（todosToPlan：cancelled 跳过、goal←content）→ analyzePlanTransition → 新完成步骤=**边界候选**（记录 pendingBoundary+progress 摘要+请求区间）。
- **压力检测**：每次 Stop hook 估算上下文 tokens（读 transcript_path 消息，chars/4 估算 + system 长度；transcript 不可读则跳过本轮）→ 滑窗(20) 增量均值 → vendor core/economics.decideCompaction（常量 1:1：memo=1000、keepRecent=20000、ratio=12.5、首次×2、后续×1.5+debt 门、windowReserve=16384；contextWindow 取 G4 projection.contextWindow=1,000,000 经 SessionStart payload.model 或默认）。
- **动作通道（API 现实下的等价实现）**：
  1. decision.compact=true（经济或窗口保护）→ Stop hook 返回 additionalContext 提醒（**不再 block**，避免干扰）：`[sol-occ] boundary reached; compaction is now economical (est. saving X tokens). Keep new requests lean; consider finishing the current step before adding large outputs.`，occ-state 记录 advised。
  2. **原生 autoCompact 兜底窗口保护**：Zcode 运行时存在 autoCompactIfNeeded/autoCompactThreshold（自动压缩），窗口压力最终由宿主处理——插件不重复触发（C4：运行时决策归宿主/harness）。
  3. **压缩后提醒（对齐"优化成功→推进+提醒"语义）**：SessionStart(source=compact) hook 检测到刚发生原生压缩 → additionalContext 注入 upstream 文案："Online context compaction finished. The parent task is still active. Before continuing work, call TodoWrite with a fresh plan for the remaining work."（用原生 TodoWrite 替代上游 update_plan）→ 模型收到提醒继续（SessionStart 注入已验证可达模型，G9）。
- **状态机**：occ-state.json（epoch/boundary 请求区间史/正增量均值/compaction 计数/债务）+ 每次变更 append occ-history.jsonl（hash 链）；用户 prompt 以 "CORRECTION:" 开头 → 清空债务（UserPromptSubmit hook 检测）。
- **与原版差异（诚实声明，README/报告必列）**：原版可主动 `context.compact()`+触发续跑；Zcode 无公共 API → 插件只做**候选选择、经济学判定、建议注入、压缩后提醒**，实际压缩由宿主原生 autoCompact//compact 执行。经济学与边界算法 1:1。

### 2.5 轨迹检查器（Trajectory Inspector）
- **通道**：全部 7 事件 hook（单脚本分发）→ vendor core/trajectory（环形缓冲 12 条、label≤96、detail≤64、剥 ANSI、批量非阻塞 append、写失败吞掉仅记一次）+ 每行 hash 链（`{schema:"sol_zcode_trajectory_v1",runId,seq,ts,event,tool,toolCallId,status,bytes/tokens 计数,prevHash,hash}`，hash=sha256(前一字段串接)）。**绝不写** prompt/assistant 文本/工具参数/工具输出（SECURITY 声明同上游；字段白名单实现+测试钉死）。
- 记录：session start/end(source)、user prompt（仅长度+哈希）、pre/post tool（工具名+callId+状态+输出字节数/截断标志，无内容）、tool failure、stop、每请求 token 估算（Stop 时点）、compaction（SessionStart compact + OCC decision reason）、config 变更。
- **查询**：MCP 工具 `sol_trajectory{action: "recent"|"stats", n?}`；CLI `node scripts/verify-evidence.mjs <dataDir>`（对账：trajectory/ledger hash 链连续性、对象文件 sha 复验、账本-对象交叉引用、**输出任何缺口=篡改/损坏证据**，exit 1）。
- **与原版差异**：SoL-Pi 独立版无此机制（散布账本）；对齐 SoL-OpenCode 的独立 trajectory 模块，增加 hash 链与 verify CLI（超出上游的防篡改强度，满足 C3"销毁行为会被揭露"）。

## 3. Opt-in 门控（C2）
- **唯一开关面**：plugin.json `userConfig`：
  - `actionFusion` (bool, default false)
  - `observationPack` (bool, default false)
  - `evidenceReducer` (bool, default false)
  - `onlineCompact` (bool, default false)
  - `trajectory` (bool, default false)
  - `actionFusionGate` (bool, default false)（Write/Edit 硬阻断引导，风险自担）
  - `reducerModel` (string, default "" = 继承主模型)
- 传递：`.mcp.json` env `${user_config.*}` 注入 MCP server；hooks.json 的 args 也支持 `${user_config.*}`（官方模板变量）→ 单一来源，两个进程面看到同一配置。**项目级/文件级配置不引入**（上游有项目 config，但 Zcode userConfig 是官方唯一持久化通道；保持单一事实源）。
- **禁用=零行为**：全部 false 时：hooks 脚本启动即读配置，全关→stdout 空、exit 0（不做任何事）；MCP server 仍须可连（宿主会拉起）但 tools/list 返回空列表 + 日志一行。测试钉死"全关→tools/list 空、hook 无副作用文件"。
- **非法值回退**：类型不符→按 false 处理 + trajectory 记 config_rejected（fail-safe 而非 fail-crash，理由见 §1 原则）。

## 4. 证据保留与防篡改（C3）
1. 原文永不清除：观察/归档对象内容寻址落盘先于任何替换；回执带 source_artifact 绝对路径 + readback 行。
2. 完整性强制：O_CREAT|O_EXCL|O_NOFOLLOW 0600、目录 0700；EEXIST→逐字节+sha256 复验，不一致=**integrity failure 异常**（写入 trajectory + 上抛为工具错误文本）。
3. 账本不可抵赖：observation/reducer/trajectory 三类 JSONL 全部 append-only + **每行 prevHash→hash 链**；删除/改写任意行 → verify CLI 报链断裂（行号+期望/实际哈希）。
4. verify CLI 交叉对账：账本引用的每个对象 id/sha256 必须存在且内容哈希相符；多余对象（账本无记录）也报告。
5. 引用可验证：回执每条 quote 带 quote_sha256 与行号；validateReceipt 逐字核验。
6. 权限：对象/账本 0600、目录 0700（属主可读=原始记录可读）。

## 5. 配置项与默认值汇总
| 项 | 默认 | 说明 |
|---|---|---|
| actionFusion/observationPack/evidenceReducer/onlineCompact/trajectory | false | 五机制 |
| actionFusionGate | false | 原生 Write/Edit exit-2 硬引导 |
| reducerModel | "" | 空=继承主模型（Zcode 决定） |
| （内置常量，不暴露配置） | 10KiB/2/16KiB/400/4096/600k/12/600/90s/12.5/20000/16384/1000/3 | 与上游一致，vendor core 内定义 |

## 6. 测试计划
1. **core 单测**：vendor 时逐模块带 SoL-OpenCode 的 vitest 套件（等价移植为 node:test，断言不变：占位确定性/分页逐字节还原/quote 逐字核验/经济学数值例/状态机转移/hash 链）。
2. **协议集成测试**（无模型）：MCP server 用 stdin 脚本驱动（discover/initialize/tools/list/tools/call 全握手，G11 序列）；hook 脚本用 fixture JSON 驱动（各事件输入→输出信封/exit code/落盘断言）；verify CLI 用故意篡改的账本 fixture 断言报告。
3. **headless e2e（真实模型，GLM-5.3-Flash）**：临时 ZCODE_HOME 隔离副本 + install-plugin.mjs 安装 + opt-in 开 + 场景断言（sol_write then_run 生效标记/大输出占位+obs_recall 还原/诊断日志回执/TodoWrite 边界+SessionStart(compact) 提醒注入/trajectory JSONL 无内容字段/全关时零行为）。
4. **门控测试**：全关→零注册行为；非法值→回退 false。

## 7. 基准设计（TB4，C5）
- 环境：OrbStack Docker（macOS arm64）。任务集：Terminal-Bench 4（63 题，排除 GPU 题，对齐 SoL-OpenCode tb/README 的排除法）。
- **zcode 容器化**：官方有 Linux 构建（zcode.z.ai 提供 Linux x64）；镜像内安装 node + zcode Linux 版 + 我们的插件（install-plugin.mjs 同法）+ 配置 model（GLM-5.3-Flash，凭据经环境注入容器，不进镜像/仓库）。
- **双臂**：同一任务镜像、同一提示协议；control=插件安装但五机制全关（零行为等价于未装）；treatment=opt-in 全开（含 gate）。唯一差异=userConfig。
- **计量**：每任务每臂 `--json` 的 usage（inputTokens 为主指标 + cacheRead/cacheWrite）+ 墙钟 + 异常（进程错误/超时/未产出）+ 解题率（TB4 verifier rewards）；成本 = Σ(tokens×GLM-5.3-Flash 官方定价，input/output/cache 分价，写死定价表并注明来源日期）。reducer 子进程 tokens 单列（treatment 成本含它）。
- **纪律**（借 SoL-OpenCode heldout 协议，与编辑器无关部分）：跑批前 freeze manifest（插件源码树逐文件 sha256 + 配置 + 任务集哈希）写入 docs/bench/freeze-manifest.json；结果 append-only ledger（benchmark/results/ledger.jsonl）；报告只从 ledger 派生；两臂任务顺序交错、并发度 ≤4（OrbStack 资源）。
- **范围**：先 3 题探针（打通管线+成本校准）→ 全量 63 题×2 臂（预算 ~$10、~60h 墙钟 @并发 4 → ~8-16h）。时间不允许全量时：报告明确标注子集与原因（诚实优先）。

## 8. 已知限制与偏差声明（写进 README 与最终报告）
1. 观察包无"前 2 次全量"语义（无历史投影 API）→ 自有工具首次即占位（省更多但语义更激进，靠摘录+召回兜底）。
2. 原生工具大输出不可改写（官方限制）→ 仅归档+账本；token 节省主要来自 sol_* 包装工具与 reducer。
3. OCC 不能主动触发压缩/续跑（无 API）→ 建议+提醒模式 + 宿主原生 autoCompact 兜底。
4. reducer 走 headless 子进程（每次诊断结果一个 node 进程 + 一次模型调用）→ 墙钟代价（SoL-OpenCode 实测 +136%），靠 LRU 缓存缓解。
5. JSON permissionDecision deny 被宿主无视（G8）→ 硬门用 exit-2（stderr reason ≤4KB）。
6. `--max-turns` 损坏（G3）→ 基准靠 prompt 协议与超时控制。
