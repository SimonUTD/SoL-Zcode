# 设计方案审核报告 — AUDIT_2026-09-13-design

- 审核对象：`docs/DESIGN.md`（v1）、`docs/PLAN.md`（v1）、`docs/GOTCHAS.md`、`docs/RESEARCH/*.md`
- 交叉材料：`SoL-Pi/`（本地克隆 d7ecfc0，2026-09-11）、`sol-opencode/`（本地克隆）、`zcode-plugins/`（官方市场仓库）、`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（0.16.5，只读反编译）
- 审核方式：文档通读 → 上游常量/行号逐项比对 → 运行时（zcode.cjs）反编译核验 DESIGN 的关键 API 假设 → 官方插件仓库规范比对 → 基准公平性与派单边界推演
- 日期：2026-09-13

---

## 1. 总体结论

**评分：6.5 / 10（未达 ≥9.5 的 P0 验收门，不可直接开工，需修订后重审）。**

研究底稿质量很高：对上游 SoL-Pi 的转述抽查 15+ 项常量/行号/流程**全部属实**；对 sol-opencode core 可 vendor 性的判断成立；对 Zcode 能力边界的表格（RESEARCH/zcode-plugin-api.md §4）除一处外全部被运行时代码佐证。

但 DESIGN 在三个**关键的"通道假设"上踩空**，其中一个是硬约束级：

1. **BLOCKER B1**：hooks 的 command/args **不支持** `${user_config.*}` 模板展开（运行时 `$V` 函数正则仅含 11 个环境变量名；`user_config` 展开器 `Bm` 只应用于插件 MCP 配置）。DESIGN §3 的 opt-in 门控闭环（C2 硬约束）在 hooks 侧按现稿**无法实现**。
2. **MAJOR M1**：运行时 `runSessionStartHooks` 只有 `"startup"` 与 `"resume"` 两个调用点，**不存在 SessionStart(source=compact)**——原生/手动压缩后不触发任何 SessionStart hook。OCC 的"压缩后提醒"通道（DESIGN §2.4-3）是死通道。
3. **MAJOR M2**：Stop hook 返回的 additionalContext **只有在同时 decision:block 时**才会注入模型（运行时 `injectHookAdditionalContextIntoMessageHistory` 共 4 个调用点，Stop 的那个在 `shouldContinueAfterStopHooks` 分支内）。DESIGN §2.4-1 明确"不再 block"→ 提醒**永远到不了模型**。

三者叠加：机制 4 的两条"提醒"通道全部落空，hooks 侧全部机制（gate/OCC/trajectory/归档遥测）失去配置来源。此外还有 reducer 子进程的 4 个 MAJOR（argv 传参上限、工具面注入、无防重入、与 PLAN 的 gate 矛盾）。

修复路径都是存在的（见 §6 必改项），修订后重审有望过 9.5 门。

---

## 2. 事实核查结果

### 2.1 研究底稿 → 上游 SoL-Pi：抽查全部属实

| 底稿主张 | 上游证据 | 结论 |
|---|---|---|
| FEATURE_KEYS 仅 4 键、无 trajectory | `SoL-Pi/src/sol-pi/index.ts:13-23`、`src/sol-pi/config.ts:34-39`；grep "trajectory" 全空 | ✅ |
| OP 常量 10KiB(严格>)/FULL_SENDS=2/摘录 1024B(头尾 512)/CHARS_PER_TOKEN=4/`obs_[a-f0-9]{24}`/O_NOFOLLOW/EPR 回执前缀跳过 | `extensions/observation-pack/observation.ts:13-28`（逐项一致，`bytes <= THRESHOLD` 才跳过=严格>） | ✅ |
| id=`obs_`+sha256(tool\0callId\0contentHash)[0:24] | `observation.ts:106` | ✅ |
| EEXIST 复验 size+sha，同尺寸异容=抛错 | `observation.ts:123-156` | ✅ |
| recall 16KiB(预留 512B)/400 行(含 2 行头)/2 行头格式/超限 throw | `observation-pack/index.ts`（`RECALL_MAX_BYTES=16*1024`、`RECALL_MAX_LINES=400`、`RECALL_HEADER_RESERVE_BYTES=512`、`RECALL_HEADER_LINES=2`） | ✅ |
| 占位符 12 行格式、整行摘录永不半行 | `observation.ts:178-197`、`:158-176` | ✅ |
| AF 标记常量/哈希守卫(双读+setImmediate)/失败保留写入/promise-tail 队列 | `action-fusion/then-run.ts:12-14`、`:54-68`、`:78-127`（`:122-125` 失败 join）；`file-queue.ts` | ✅ |
| EPR 常量 12/600/4096/600k/2048/90s/DIAGNOSTIC/FAILURE_SIGNAL/LIKELY_SECRET | `evidence-preserving-reducer/config.ts:14-29` | ✅（正则边界是 `(?:^|[;&|()\s])…(?:\s|$)`，底稿"词边界包裹"为近似表述，不影响移植——vendor 原文即可） |
| 回执核验全套（schema/source_sha256/status/quote≤600 且 `body.includes`(:119)/kind 白名单/去重/missing-failure-evidence(:136-142)/must-be-smaller） | `receipt.ts:82-144`、`:146-177` | ✅ |
| 归约指令关键句（lossless/untrusted/12 条/600 字符） | `receipt.ts:37-52` | ✅ |
| OCC 常量 keepRecent=20000、memo=1000、ratio=12.5、windowReserve=16384、首压×2、后续×1.5+debt 门、reason 枚举（economics 9 种+native_not_compactable=10） | `extension.ts:35-36`、`config.ts:14`、`economics.ts:14-20`、`:122-237`、`extension.ts:305-306` | ✅ |
| "CORRECTION:" 开头清债务/epoch | `extension.ts:248` | ✅ |
| 上游 fail-closed 配置（未知键/类型错抛错） | `config.ts`（loadSolPiConfig throw 路径） | ✅ |
| then_run timeout "no default timeout" | `then-run.ts:26`（"Timeout in seconds (optional, no default timeout)"）——**DESIGN §2.1 写"120s 默认"，与上游不同**（见 m4） | ⚠️ |

### 2.2 研究底稿 → sol-opencode：属实

- core 包 1596 行、零依赖（package.json 无 dependencies）、模块文件 NVIDIA SPDX 头（仅 index.ts 是 ImKK666 头）→ DESIGN"vendor + NVIDIA 头保留"成立。
- `searchObservation` 上限 20 条（`core/…/observation.ts:21` `SEARCH_MAX_MATCHES=20`）；query ≤256B 是 **OpenCode 适配层**常量（`packages/opencode/src/mechanisms/observation-pack.ts:32`）——DESIGN §2.2 把它当作召回规格的一部分，成立（我们自己的 MCP 层定同值即可）。
- reducer 四道门（`core/reducer/policy.ts:31-37`）、缓存 key 全要素（`:44-63`）、LRU=64（`cache.ts:11`）✅。
- TB4：66 题、3 题声明 `gpus=1` 排除、63 题 CPU-only（`sol-opencode/apps/bench/tb/README.md`）✅ —— DESIGN §7"63 题排除 GPU"属实。
- OCC 适配层 todo.updated→summarize、maxAutoContinuations=3（`packages/opencode/src/mechanisms/online-context-compact.ts:113-153`）✅。

### 2.3 GOTCHAS → 运行时/官方文档：基本属实，两处需修正/补充

- G8 exit-2：运行时确有 exit-2 捷径→`{continue:!1, reason, hookSpecificOutput:{permissionDecision:"deny",…}}` ✅。
- G4/G14 计量：运行时 usage 聚合函数（`q4t`）按逐请求 **reduce 求和** → "--json usage 可作会话累计计量"的基准假设成立 ✅。
- PostToolUse 不能改写工具输出：官方文档 §4.1 表明示 ✅；updatedInput 重校验 ✅（运行时 `lne` 校验）。
- **G9 反例（UserPromptSubmit additionalContext 未达模型）与运行时矛盾**：`injectHookAdditionalContextIntoMessageHistory(on.UserPromptSubmit, …)` 是真实注入点（4 个调用点之一）。GOTCHAS 自己标注"存疑，未复检"——建议复检修正（它本可成为 OCC 提醒的候选通道）。见 m8。
- **DESIGN 对 G9 的引用越界**：§2.4-3 用 G9 支撑"SessionStart(compact) 注入可达"，但 G9 只验证了 **startup** 源。compact 源在 0.16.5 根本不触发（M1）。

### 2.4 研究底稿 §9"已发表数据"无法溯源

- "45–49% tokens / ~94% / TB4 15/63 @ $211 vs 18/63 @ $286" 在本地 SoL-Pi 克隆（2026-09-11，最新）与 GitHub 线上 README（本次抓取）**均不存在**；仅见于 `sol-opencode/README.en.md:178-179`（标注"SoL-Pi (published)"）。
- 结论：底稿 §9 应改注来源为"SoL-OpenCode README 转述，未能在上游仓库核实"。（m3）

---

## 3. 运行时反编译核验（本轮审核新增的关键证据）

以下均为对 `zcode.cjs` 0.16.5 只读反编译所得，是本报告 BLOCKER/MAJOR 的直接证据：

1. **hook 执行器**：process 型 hook 以 `file:$V(r.command,…)`, `args:(r.args??[]).map(d=>$V(d,…))` 展开；`$V` 的正则为
   `/\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\}/gu`
   —— **无 `user_config.*`**。hook 条目 schema（`IRn`/`TRn`）也**没有 env 字段**。
2. **user_config 展开器 `Bm`**（含 `Missing plugin user_config value` / sensitive 门）只在**插件 MCP server 配置解析**处被调用（mcpServers 的 env/command）。
3. **无 `ZCODE_USER_CONFIG_*` 注入**：运行时 grep 为空。官方 `zcode-plugins/plugins/example-plugin/hooks/session-start.mjs:28-30` 读取 `process.env.ZCODE_USER_CONFIG_GREETING`——该变量运行时从不设置（示例靠默认值兜底），佐证生态缺此能力。
4. **SessionStart 仅两源**：`runSessionStartHooks` 全部调用点只传 `"startup"`（首个用户输入前）与 `"resume"`；手动压缩路径（`uqr`）与自动压缩（`lqr`）不触发任何 SessionStart hook。官方文档 matcher 表的"常见值 startup|clear|compact"与 0.16.5 实际行为不符（以实测为准的原则下，应为 startup|resume）。
5. **Stop additionalContext 注入条件**：`R7r(e,t)=e.stopShouldContinue===!0 && additionalContexts.length>0 && t<上限`；非 block 的 Stop additionalContext 无消费者。
6. **autoCompact 存在**（`autoCompactIfNeeded`、autoCompactThreshold、compact.auto.completed 日志）→ DESIGN §2.4-2 的"原生兜底"前提成立。
7. **userConfig 值可脚本化**：配置键 `PluginsOptions:"plugins.options"`（per-plugin id）→ 基准双臂可用 `~/.zcode/cli/config.json` 的 `plugins.options["sol-zcode@<market>"]` 程序化设置（DESIGN/PLAN 未写明，见 m6）。
8. **CLI 有未用到的旗标**：`--disallowed-tools`、`--allowed-tools`、`--attach <path>`、`--settings <path>`（`zcode --help`）——其中 `--attach` 与 `--disallowed-tools` 是 M3/M4 的现成缓解手段。
9. **usage 求和语义**（`q4t`）→ G4/DESIGN §7 计量假设成立。

---

## 4. 问题清单（分级）

### BLOCKER

**B1｜opt-in 门控闭环在 hooks 侧不成立（违反 C2 硬约束）**
- 位置：`docs/DESIGN.md:102`（§3"hooks.json 的 args 也支持 `${user_config.*}`（官方模板变量）"）；连带 §2.1 硬门、§2.2 原生遥测、§2.4 Stop/PostToolUse(TodoWrite)、§2.5 trajectory、§3 "config_rejected" 记录。
- 证据：§3-1/§3-2（运行时 `$V` 正则无 user_config；hook schema 无 env；`ZCODE_USER_CONFIG` grep 为空；官方 example-plugin 同样拿不到）。
- 后果：hooks 进程无法得知五机制开关 → 要么 hook 侧行为不受 opt-in 控制（违反 C2"未配置=全禁用"），要么 hook 侧全部禁用（gate/OCC/trajectory/归档遥测形同虚设）。
- 建议（择一或组合，须写入 DESIGN 并在 P1 验证）：
  a) hooks 直接解析 `~/.zcode/cli/config.json`（及 workspace `.zcode/config.json`）的 `plugins.options["sol-zcode@<marketplace>"]`（公开配置文件；install-plugin.mjs 已在写同一文件）；
  b) MCP server 启动时把解析后的配置落到 `$ZCODE_PLUGIN_DATA/config.resolved.json`，hooks 读取，缺失/过期一律视为全关（C2 安全侧）；
  c) 混合：a) 为主、b) 为快路径。**注意 a/b 都要处理 SessionStart 与 MCP server 的启动次序不确定问题**（首个事件可能拿不到 b 的文件）。

### MAJOR

**M1｜OCC"压缩后提醒"依赖不存在的 SessionStart(compact) 事件**
- 位置：`docs/DESIGN.md:83`（§2.4-3）。
- 证据：§3-4（runSessionStartHooks 仅 startup/resume；uqr/lqr 无 hook）。
- 后果：机制 4 的"优化成功后任务推进并收到提醒"在 Zcode 侧无触发点。
- 建议：改为 Stop hook 内检测压缩（对比本会话上次观测的 transcript 长度/条目骤降或压缩标记；transcript_path 在 Stop 时可读，G5）→ 下一次可用注入通道送达提醒；或经 MCP 工具输出/PreToolUse additionalContext（运行时证实注入到工具结果上下文）传达。需实测选定并写入 DESIGN。

**M2｜OCC"经济性提醒"经 Stop additionalContext（不 block）送达——该输出会被丢弃**
- 位置：`docs/DESIGN.md:81`（§2.4-1"返回 additionalContext 提醒（不再 block，避免干扰）"）。
- 证据：§3-5（R7r 条件 + 4 个注入点）。
- 后果：提醒永远不可达，机制 4 仅剩"候选+经济学判定"半截。
- 建议：要么用 `decision:"block"`+reason（≤3 次连续；最贴近上游"压缩后续跑"语义，但会改变回合行为，需在基准里如实计量），要么把提醒改为 PreToolUse additionalContext / sol_* 工具输出内附加一行。二选一并写入偏差声明。

**M3｜reducer 子进程：yolo 全工具面 + max-turns 失效，注入面远大于上游"禁工具子会话"**
- 位置：`docs/DESIGN.md:73`（§2.3 归约模型调用）。
- 证据：上游 provider 调用带 `tools 禁用 + maxTokens 2048`（SoL-Pi provider.ts options；sol-opencode 子会话 `tools:{}`）；本项目子进程 `--mode yolo` 且 `--max-turns` 损坏（G3）→ untrusted log 中的注入指令可驱动子代理执行任意命令（自动批准）。
- 建议：子进程加 `--disallowed-tools`（CLI 已提供，枚举全部内置+插件工具或用白名单 `--allowed-tools` 置空）；提示词防线保留但不得作为唯一防线；补一条对抗性 e2e（log 中埋"run rm…"指令，断言无副作用）。

**M4｜reducer 全文经 `--prompt <text>` argv 传递，超限必炸（fail-open 掩盖）**
- 位置：`docs/DESIGN.md:73`。
- 证据：Linux `MAX_ARG_STRLEN`=128KiB/单参数（macOS 256KiB）；候选 body 4KiB–600k 字符；>128KiB 的日志 spawn E2BIG → 按设计 fail-open 回原文——**机制恰好对最大的日志静默失效**，基准里表现为"看起来没故障"。
- 建议：日志写临时文件经 `--attach <path>` 传（CLI 已提供）；或 stdin。写入 DESIGN §2.3。

**M5｜reducer 子进程无防重入（isAuxSession）——子会话会再次加载本插件**
- 位置：DESIGN §2.3/§1（未提及）；对照 `docs/RESEARCH/sol-opencode-port.md:29`（sol-opencode Kernel 有 `isAuxSession 防重入标记`）。
- 后果：headless 子进程继承全局插件配置：其 SessionStart 收到"优先用 sol_* 工具"引导、hooks 写 trajectory、其自身工具输出可再触发 OP/EPR——计量污染与潜在递归。
- 建议：spawn 时设 `SOL_ZCODE_AUX=1`（或等价）环境标记；hooks/MCP 启动即检查，aux 会话一律零行为；e2e 断言之。

**M6｜DESIGN 与 PLAN 在"treatment 是否含 gate"上直接矛盾**
- 位置：`docs/DESIGN.md:131`（"treatment=opt-in 全开（**含 gate**）"）vs `docs/PLAN.md:51`（"基准 treatment 主配置**不含 gate**（只用引导），gate 作为附加消融选项"）。
- 后果：双臂定义不确定 → freeze manifest 无法钉死，C5 报告口径存疑。PLAN 的口径（不含 gate）更合理（exit-2 硬门会引入拒绝-重试循环，混淆"机制省 token"与"引导方式"两个变量）。
- 建议：修订 DESIGN §7 与 §5 表述统一为"treatment 不含 gate；gate 为可选消融臂"；freeze manifest 记录最终选择。

### MINOR

- **m1**｜`docs/DESIGN.md:61`（§2.1 C4 合规）："shell 行为……不引入新 shell"的主张过强：sol_bash/then_run 的 `child_process spawn("/bin/sh -c")` 绕过宿主 Bash 的权限门/沙箱/30000 字符截断/持久化输出治理，"语义一致"仅覆盖命令行语义。建议：README 偏差声明补一条"MCP 工具自行执行命令，不经宿主 Bash 审批链"，并核实 MCP 工具默认审批行为（needsApproval）后在文档写明。
- **m2**｜`docs/DESIGN.md:109`（§4.3）："删除/改写任意行 → verify CLI 报链断裂"对**尾部删除**与**整链重写**不成立（无外部锚点/签名；上游自述"可检测而非可预防"）。建议：措辞降级为"行内改写/中段删插可检测"；可选增强：会话收尾写长度/终哈希锚点到第二位置，verify 校验。
- **m3**｜`docs/RESEARCH/sol-pi-mechanisms.md` §9"已发表数据"无法在上游验证（见 §2.4）——改标来源，避免最终报告（P4）引用失实。
- **m4**｜then_run 超时默认 120s ≠ 上游"no default timeout"（`SoL-Pi/…/then-run.ts:26`）；`sol_write/sol_edit` "自实现变异、语义对齐内置工具"（DESIGN §2.1）实为最大的一处重写（内置 Edit 的唯一匹配校验/read-before-write/换行处理等都要复刻），却未列入 §8 偏差清单。建议 §8 增补，并在 P1 协议测试加"sol_edit 与内置 Edit 行为等价"用例组。
- **m5**｜`docs/DESIGN.md:79`（§2.4）："SessionStart payload.model"无依据（G5 字段清单无 model）；"滑窗(20)"与"3（maxAutoContinuations）"是 sol-opencode 适配层常量而非上游（上游为累计均值），"常量 1:1"表述应限定为 economics.ts 常量；§5 表中 FULL_SENDS=2 在"首次即占位"方案里无作用，建议标注"仅账本语义保留"。
- **m6**｜派单/落点小冲突：DESIGN §7 freeze manifest 落 `docs/bench/freeze-manifest.json`，但 PLAN P3 可写范围仅 `benchmark/**` 且 docs/ 只读；`scripts/install-plugin.mjs` 的归属阶段未写明（P1 scripts/** 隐含、P2 e2e 依赖）；双臂如何**程序化写 userConfig**（plugins.options，见 §3-7）PLAN P3 未列必做。
- **m7**｜`docs/DESIGN.md:130`"官方有 Linux 构建（zcode.z.ai 提供 Linux x64）"无 GOTCHAS/研究底稿佐证，且与 G1"无独立 CLI 产品"存在张力；PLAN 已有预案，但应在 P3 开工前实测验证（容器内 `node zcode.cjs --prompt … --json` 冒烟）并把结论落 GOTCHAS。
- **m8**｜GOTCHAS G9 反例（UserPromptSubmit additionalContext 未达模型）与运行时注入代码矛盾——复检后修正记载；若复检通过，它是 OCC 提醒的又一候选通道（与 M1/M2 的修复相关）。

---

## 5. 硬约束逐条评估

| 约束 | 结论 | 说明 |
|---|---|---|
| C1 仅公共插件 API | ✅（基本成立） | hooks+MCP+manifest；reducer spawn 宿主 CLI 属"用宿主产品 headless 模式"，非 patch/附加模块。m1 的 shell 审批链绕过是灰色地带，建议显式声明。 |
| C2 显式 opt-in/未配置全禁用 | ❌（按现稿不成立） | MCP 侧成立（默认全 false、tools/list 空）；hooks 侧无配置通道（B1）。修复后可成立。 |
| C3 证据保留/可读/销毁可揭露 | ✅（大体成立，主张略过强） | 内容寻址+O_EXCL 复验+回执 readback+逐字核验均忠实上游且落点清晰；m2 两处措辞需降级。 |
| C4 auth/URL/模型/shell 归宿主 | ⚠️ | auth/URL/模型：成立（G2 三段式+reducerModel 默认继承）。shell：主张过强（m1）；reducer 子进程工具面失控（M3）是对"运行时决策归 harness"精神的实质违背风险。 |
| C5 TB4 双臂对比 | ⚠️ | 框架扎实（freeze/ledger/探针先行/交叠双臂/诚实降级条款），计量假设经运行时验证（usage 求和）；但 M6 双臂定义矛盾必须先解决，m6 三处落点/必做缺口需补。 |

五机制保真度小结：
1. **AF**：核心（标记/哈希守卫/队列）1:1 可达成；差异（新工具名+引导/硬门、自实现变异、120s 默认）需按 m4 补进偏差清单。
2. **OP**：受 API 所限的"首次即占位"与"原生仅归档"均已在 §8 诚实声明；召回/搜索/账本规格与 core 一致。
3. **EPR**：流水线/校验/缓存 1:1；传输层换 headless 子进程是必要创新，但带出 M3/M4/M5 三个必须修的缺陷；另 headless 无法设 `maxTokens 2048/cacheRetention none`，成本上界只剩 90s 超时（建议 §8 补记）。
4. **OCC**：economics/plan vendored 1:1；但两条提醒通道（M1/M2）死亡使"优化成功→推进+提醒"不可交付，须重设计通道；估算器偏差（chars/4、滑窗）可接受但应声明（m5）。
5. **Trajectory**：设计良好，仅元数据+hash 链+verify CLI，超出上游，C3 友好；受 B1 牵连需解决配置来源。

可行性与派单：P1→P4 依赖清晰、边界基本无重叠；m6 三处小冲突（freeze manifest 路径、install-plugin 归属、userConfig 程序化写入）需在派单前修订。B1/M1/M2/M3/M4/M5 的修订都集中在 DESIGN §2/§3/§7——修订量可控（预计 1 个编辑会话），不动总体架构。

---

## 6. 必改项清单（修订后重审）

| # | 级别 | 位置 | 改法 |
|---|---|---|---|
| B1 | BLOCKER | DESIGN §3（及 §2 各 hook 落点） | hooks 配置通道改为 config.json(plugins.options) 解析 + MCP 落盘快照（全关缺省），并写明启动次序处理 |
| M1 | MAJOR | DESIGN §2.4-3 | 压缩检测改道（Stop 内 transcript 对比或工具输出通道），删除对 SessionStart(compact) 的依赖 |
| M2 | MAJOR | DESIGN §2.4-1 | Stop 提醒改为 decision:block+reason 或 PreToolUse/MCP 通道，权衡写入偏差声明 |
| M3 | MAJOR | DESIGN §2.3 | 子进程加 --disallowed-tools/--allowed-tools 白名单；补对抗性 e2e |
| M4 | MAJOR | DESIGN §2.3 | 日经 --attach 临时文件（或 stdin）传递，弃 --prompt argv |
| M5 | MAJOR | DESIGN §2.3/§1 | aux 环境标记防重入；e2e 断言 |
| M6 | MAJOR | DESIGN §7:131 | 与 PLAN 统一为"treatment 不含 gate"，freeze manifest 钉死 |
| m1–m8 | MINOR | 见 §4 | 措辞降级/来源改注/§8 补偏差/派单补丁/G9 复检 |

---

## 7. 扣分明细与评分

| 维度 | 权重 | 得分 | 依据 |
|---|---|---|---|
| 事实准确性（研究底稿→上游/参考仓库） | 30% | 9.0 | 抽查 15+ 项全对；扣 §9 数据无法溯源（m3） |
| 方案正确性（API 假设/通道可行性） | 30% | 5.0 | B1 死假设 + M1/M2 死通道（均有运行时反证） |
| 硬约束满足（C1–C4） | 20% | 6.5 | C2 按现稿不成立、C4 两处过强/失控、C1/C3 基本成立 |
| 完整性/可落地性/基准（C5）/派单 | 20% | 7.5 | 基准框架扎实+计量假设验证通过；M6 矛盾与 m6 缺口 |

**加权 ≈ 6.6 → 最终评分 6.5 / 10**（取半档从严）。
未达 PLAN P0 的 ≥9.5 验收门：**不通过，修订必改项后重审**。B1+M1–M6 全部为方案级修订（不动架构），预计一轮修订+一次复核可达标。

---

## 8. 审核人备注（正面发现，供保持）

- 研究底稿的行号级精度（receipt.ts:82-144、economics.ts:122-237、observation.ts:98-117 等）逐一对得上，是高质量的调查工作。
- "fail-open 优先于上游 fail-closed"（DESIGN §1）的本地化决策论证充分，与 C2 一致。
- §8 已知限制清单的诚实度高于多数同类方案（无历史投影、原生输出不可改写、OCC 无触发 API、reducer 墙钟代价均已自曝）。
- 基准纪律（freeze manifest、append-only ledger、探针先行、子集诚实标注）直接继承 held-out 做法且与编辑器无关部分移植得当。
