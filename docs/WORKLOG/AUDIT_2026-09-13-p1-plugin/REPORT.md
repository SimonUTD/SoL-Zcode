# P1 插件实现审核报告 — AUDIT_2026-09-13-p1-plugin

- 审核对象：commit `f2f90de` "feat(P1): sol-zcode plugin — five token-efficiency mechanisms"（`plugin/`、`tests/`、`scripts/`，46 文件 6824 行；工作树与 commit 一致，无未提交改动）
- 方案依据：`docs/DESIGN.md`（v2 终审 9.5 通过版）、`docs/PLAN.md`（P1 派单）、`docs/GOTCHAS.md`（G1–G19）、`docs/RESEARCH/*.md`、`docs/WORKLOG/AUDIT_2026-09-13-design/REPORT.md`
- 对照源：`sol-opencode/packages/core/src|test/`（vendor 保真度）、`zcode-plugins/plugins/example-plugin/`（官方范式）、`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（0.16.5 运行时反编译复核）
- 审核方式：全部 46 文件通读 → vendor 逐文件与上游 .ts 对照 → 运行时反编译核验（工具名表/disallowed-tools 解析格式/MCP 子进程 env）→ `node scripts/run-tests.mjs` 全量复跑 → **独立 live 冒烟 3 次（隔离 HOME，真实宿主 + 真实模型）** → verify-evidence 人工篡改实测 → reducer 真实二进制端到端实测
- 日期：2026-09-13

---

## 1. 总体结论

**评分：9.0 / 10（未达 ≥9.5 的 P1 验收门，需修 2 个 MAJOR 后快速复审）。**

实现纪律性显著高于一般 P1 交付：15 个 vendor 文件经逐行对照确认为**类型擦除级忠实移植**（全部常量/分支/断言语义不变，SPDX 头保留，仅有的改动全部在文件头与 THIRD_PARTY_NOTICES 中如实申报）；114 个测试全部真实（无假绿：断言具体、fixture 经真实子进程/真实文件系统、含 3 进程并发链写入测试）；12 条申报偏差**逐条属实且全部 fail-safe**。C1（零依赖，仅 node:*）与 C2（未配置=零行为）经本审核在真实宿主上独立复核通过；C3 防篡改链经人工篡改实测可抓；C4 凭据链路干净（凭据从不进插件代码，reducer-home 按调用重建/清理，实测无残留）。

未达门的原因是两个 MAJOR：

- **M1**：reducer 子进程 `--disallowed-tools` 枚举表**漏掉 CronCreate/CronDelete/CronList/CronUpdate**——这 4 个是 0.16.5 运行时真实注册的内置工具（本审核在 zcode.cjs 注册表中核实），代码注释却声称 "runtime-verified set"。PLAN P1 开工首任务②要求的"内置工具全集覆盖实证"未做实。
- **M2**：哈希链 append 的 `readLastLine` 固定 64KiB 读窗——**单行 >64KiB 的账本行会使后续 append 从创世哈希重开链**（本审核已构造复现）。occ-history 每行嵌入完整状态（含计划），`parsePlanSteps` 允许单条 goal ≤16KiB、128 步，现实中可超 64KiB；触发后链断裂、verify 误报篡改、session-summary 锚点降级。失败方向是"误报"而非"漏报"（fail-loud），故为 MAJOR 而非 BLOCKER。

另发现 14 条 MINOR（见 §6）。两项 MAJOR 的修复都很小（补 4 个工具名；读窗自适应或限制 occ-history 行长），修复后预计一轮 diff 复审可达 9.5。

---

## 2. 独立实证记录（本审核新增，全部可复现）

| # | 实验 | 结果 |
|---|---|---|
| V1 | `node scripts/run-tests.mjs` | **114/114 全绿**（30.7s；实为 62 unit + 52 integration，commit message 写 61+53，拆分计数差 1，总数正确） |
| V2 | 隔离 HOME 安装 + `--options {actionFusion,observationPack,trajectory:on}`，headless 真实模型，提示用 sol_bash 跑 `seq 1 2000`（8893B < 10KiB） | 模型经 SessionStart 引导正确使用 sol_bash；ledger 记 `event:full`（阈值判定正确）；trajectory 链/session pointer/session-summary 全部落盘且**会话归属正确**（非 mcp-direct） |
| V3 | 同 HOME 改 `--options '{}'`，headless "Reply OK" | 会话正常完成，插件数据目录**零新增文件**——C2 在真实宿主独立证实 |
| V4 | 对开发方冒烟数据运行 verify-evidence | OK（开发方申报的 `obs_622395d1d856a352b60cb2c2` 真实存在：13893B 对象 + placeholder 账目，冒烟证据可信） |
| V5 | 拷贝冒烟数据后两处篡改（对象内容改 1 字节 + trajectory 截断首行保留） | verify-evidence **exit 1**，同时报 `observation-object-hash-mismatch` 与 `anchor-truncation`（session-summary 锚点生效） |
| V6 | **reducer 真实链路**（开发方冒烟未覆盖：其数据 reducer objects=0）：`--options {evidenceReducer:on}`，sol_bash 跑 cargo build + 300 行 error 输出 + exit 1 | 真实 `zcode.cjs` 子进程经 **ps 嗅探解析**成功拉起（隔离 HOME+attach+disallowed-tools），46s 后回执落账：18519B 原文归档 → 903B 回执（1 条证据，逐字核验通过，receipt-not-smaller 通过）；ledger candidate→applied 完整；reducer-home 用后即清（run/ 无残留）；verify 全绿 |
| V7 | zcode.cjs 反编译复核 | ① 插件 MCP 子进程 env 确无 `ZCODE_SESSION_ID`/`ZCODE_PLUGIN_ID`（偏差#5 的前提属实）；② `--disallowed-tools` 接受逗号/空格分隔列表（`join(",")` 用法正确）；③ 内置工具注册表实际含 Agent/Bash/Cron×4/Edit/Glob/Grep/Read/Skill/TodoRead/TodoWrite/Write（+条件性 AskUserQuestion/EnterPlanMode/ExitPlanMode/NotebookEdit/WebFetch/WebSearch 等）——**Cron×4 不在 BUILTIN_TOOL_NAMES**；④ 插件 MCP 工具命名 `mcp__plugin_<plugin>_<server>__<tool>` 与本会话 context7 插件实例一致（偏差#4 属实） |

---

## 3. 硬约束逐条评估

| 约束 | 结论 | 依据 |
|---|---|---|
| C1 仅公共 API/零依赖 | **✅** | 全部 import 为 `node:*` + 相对路径；无 package.json、无 node_modules；hooks.json/.mcp.json/plugin.json 与官方 example-plugin 逐字段同构 |
| C2 未配置=零行为 | **✅（V2/V3 独立证实）** | 缺文件/损坏 JSON/无 options/aux → 全关且零文件（hooks.test 3 个用例 + 本审核 V3）；MCP 全关→tools/list 空 + tools/call 拒绝；类型错→false + config_rejected（见 m10 的设计内张力） |
| C3 证据链 | **✅（带 1 个 MAJOR 边界）** | O_EXCL+EEXIST 逐字节+sha 复验（vendor 原样）；链实现/校验正确（含插入/改写/删行检测，chain.test 全过 + V5 实测）；跨账本-对象对账+锚点交叉校验真实有效；**但 >64KiB 行会断链（M2，已复现）** |
| C4 凭据/隔离 | **✅（带 1 个 MAJOR 缺口）** | 凭据零处进插件：reducer-home 仅程序化拷贝 `{provider,model}`；模型继承宿主配置、reducerModel 有 registry 预校验（P1 终审提示①落实）；按调用重建/清理（提示②落实，V6 验证无残留）；三层防护真实生效（V6 中隔离 HOME/aux/disallowed-tools 全部就位）——**但第 2 层枚举漏 Cron×4（M1）** |

五机制保真：vendor 层 1:1（§4）；适配层按 DESIGN §2 落地——AF 标记契约/哈希守卫/队列 1:1，变异为申报的自实现且等价组覆盖契约项；OP 首次即占位+召回逐字节（集成测试做了 40KiB 全量分页还原断言）；EPR 四道门/归档/LRU(64)/validateReceipt 全套/receipt-not-smaller/fail-open 全在（V6 真实模型端到端过）；OCC 边界+滑窗+economics（常量 1:1）+Stop-block 自限（连续 2/总 3）+压缩检测延后提醒（occ.test 钉死）；trajectory 字段白名单+仅元数据（测试断言 prompt 文本绝不落盘）。

---

## 4. Vendor 保真度核查（sol-opencode core → plugin/core）

15 文件逐一对照上游 `packages/core/src/*.ts`：

- **逐行等价（类型擦除，算法/常量/分支/断言语义零改动）**：then-run、file-queue、economics、plan、observation（除申报的 skip 前缀改名）、ledger、archive、cache、policy、trajectory/{store,jsonl}。抽查关键点全对：THRESHOLD_BYTES=10240 严格>、id=sha256(tool\0callId\0contentHash)[0:24]、EEXIST 复验 size+sha 异容即抛、摘录 512B 头尾完整行、recall 16KiB/400 行、search 20 条上限、economics {16384, 2, 1.5, 3样本, 0.5}、receipt 核验全套（`body.includes(quote)`、kind 白名单、≤12 条 ≤600 字符、`kind\0quote` 去重、missing-failure-evidence、status 一致）、archive `wx` 0600 分桶、LRU(64) 命中 usage 归零、环 12/label 96/detail 64/剥 ANSI、promise-tail 队列。
- **申报改动（全部与 THIRD_PARTY_NOTICES 及回执一致）**：`REDUCER_RECEIPT_PREFIX/SCHEMA` 改名（跨机制不变式"skip 前缀 === 回执前缀"保持，且有测试钉死）；`loadReducerConfig` 增 `options.storeRoot` 覆盖（缺省行为不变）；`reducerInputHeader` 新增（字段集与 `reducerInput` 头一致）；`readback` 行指向自有召回工具；model.ts（上游 types-only）以 JSDoc 文档化。
- **SPDX 头**：NVIDIA/ImKK666 归属逐文件与上游一致保留；THIRD_PARTY_NOTICES.md 准确。
- **单测移植**：与上游 vitest 套件断言等价（then-run/reducer/observation/economics/plan/file-queue/trajectory 逐用例对照），无断言弱化。

结论：**vendor 无未申报偏差。**

---

## 5. 12 条申报偏差核实结论

| # | 声明 | 核实 | 备注 |
|---|---|---|---|
| 1 | receipt 首行 `sol_zcode_evidence_receipt_v1` | **属实，fail-safe** | config.mjs:28 与 observation.mjs:41 锁步改名，不变式有测试；隔离 HOME 下回执文本不会回流宿主其他工具 |
| 2 | loadReducerConfig 增 storeRoot 覆盖 | **属实，缺省不变** | config.mjs:67；THIRD_PARTY_NOTICES 申报 |
| 3 | TodoWrite 无 id→内容哈希合成 id | **属实** | occ.mjs:98-101；边界情形：同内容重复 todo → id 撞 → parsePlanSteps 拒绝 → 该次计划更新被静默丢弃（m5，漏报方向） |
| 4 | 工具名 `mcp__plugin_<plugin>_<server>__<tool>` | **属实（V7-④ 双源证实）** | sol-hook.mjs:113 防御式正则同时覆盖长短形 |
| 5 | MCP 无 session env→指针文件+cwd 匹配，回退 mcp-direct | **属实（V7-① 证实前提；V2/V6 归属正确）** | 残留弱点 m1：ctx 在 server 启动时一次性解析，若抢在首个 hook 之前则整会话粘 mcp-direct |
| 6 | 600s 安全阀 | **属实，且经 DESIGN §3(n3) 预授权** | tools.mjs:59 + `.mcp.json` timeoutMs 600000 内外交一致；then_run 传 timeout 时也封顶 600s |
| 7 | install --options 替换语义 | **属实** | install-plugin.mjs:103-108，`--options '{}'` 确定性全关（V3 实测） |
| 8 | contextWindow 默认 1M | **属实** | occ.mjs:31；payload 无该字段时安全缺省（宿主 --json projection 实际报 1e6，恰与本默认一致） |
| 9 | session-summary 每次 Stop 刷新 | **属实，方向更强** | 偏离 DESIGN §4.3"会话末"的字面，但每轮刷新让锚点更新、截断检测窗口更小；verify 兼容"锚点后增长" |
| 10 | config_rejected 语义 | **属实** | 仅 hooks 侧记（m12：MCP 侧静默）；DESIGN §3 内在张力的裁决见 m10 |
| 11 | 等价测试为契约级 | **属实且头部诚实** | 但 P1-5 原文"写前读"被重释为"文件必须存在"——内置 Read-before-Edit 会话跟踪语义未被复刻也未测（m9）；真模型等价 P2 |
| 12 | run-tests.mjs 包装 | **属实** | Node v25.8.0 实测目录参数确不可用，glob 展开形式工作正常 |

**总评：12/12 如实申报，无一隐瞒；除 #5/#11 附带小缺口外全部 fail-safe。**

---

## 6. 问题清单

### MAJOR

**M1｜reducer 工具面第 2 层枚举不完整：漏 CronCreate/CronDelete/CronList/CronUpdate**
- 位置：`plugin/hooks/lib/reducer-subprocess.mjs:42-63`（BUILTIN_TOOL_NAMES）；对照 `zcode.cjs` 注册表（`name:"CronCreate"` 等 4 个真实内置工具，本审核 grep 证实）。
- 影响：DESIGN §2.3 第 2 层"枚举全部内置工具"未达成；yolo 子进程内 untrusted log 注入可驱动 CronCreate（持久化落在被删的 reducer-home，但 90s 窗口内可触发新运行时）。第 1/3 层与 validateReceipt 仍在，故非 BLOCKER；但代码注释"runtime-verified set"与事实不符，且这正是 PLAN P1 首任务②要求实证的覆盖面。
- 建议：补 4 个 Cron 名（顺带删去 0.16.5 不存在的 Task/ListMcpResources/Memory 亦可留作前向兼容）；P2 对抗性 e2e 增加 Cron 注入向量；把枚举表与 `zcode --help`/注册表的核对结论回写 GOTCHAS。

**M2｜哈希链 append 对 >64KiB 单行断链（occ-history 为现实暴露面）**
- 位置：`plugin/hooks/lib/chain.mjs:80-97`（readLastLine 固定 64KiB 窗）→ `appendChained`（:117-135）在 head 解析失败时静默从 GENESIS 重开；`occ.mjs:73-82` 将完整 state（含 plan）逐行嵌入 occ-history。
- 复现（本审核）：构造 73953 字节 state 行 + 1 行后续 append → `verifyChainFile` 报 `chain-break`，后续行 prevHash=创世。
- 触发面：`parsePlanSteps` 允许 128 步 × goal ≤16384B（单条 66KB goal 即触发）；模型写长 todo 完全可能。
- 影响：链断裂→verify 误报篡改（fail-loud 不漏报）、session-summary lastHash 失效；DESIGN §4.3 的"账本-对象对账即防篡改审计"在基准长会话下可信度受损。
- 建议：readLastLine 自适应（读到不完整行时窗口倍增重试，或按文件尾部向前找最后一个 `\n` 完整行为止）；或 occ-history 改存状态摘要+全文哈希引用。补一条 >64KiB 行的回归测试。

### MINOR

- **m1**｜`plugin/mcp/server.mjs:97` + `tools.mjs:72-77`：session 指针在 server 启动时一次性解析；若 MCP server 先于首个 hook 事件拉起，整会话账本归属粘在 `mcp-direct`。建议 tools/call 时惰性解析（或指针出现后失效缓存）。两次冒烟均归属正确，现实竞窗小。
- **m2**｜`plugin/mcp/tools.mjs:270-277`：缓存 key 在 reducerModel 未设时用占位符 `zcode-host-default` 而非解析后的宿主模型——宿主中途换模型会跨模型复用回执，弱化 policy.ts"key 覆盖全部输入"的上游不变式。
- **m3**｜`plugin/mcp/server.mjs:41-50`：`enqueueToolCall` 串行化全部工具调用——一个 600s sol_bash 会阻塞同会话并发 obs_recall/sol_trajectory。串行换账本确定性，可接受但宜记录。
- **m4**｜`plugin/hooks/lib/reducer-subprocess.mjs:134-143`：同一 plugin-data 根下两个并发宿主会话同时跑 reducer 会互相 rm 对方 reducer-home（server 内串行救不了跨进程）→ 一方 fail-open 回退原文。基准（每任务独立 HOME）不受影响。
- **m5**｜`plugin/hooks/lib/occ.mjs:91-111`：内容哈希 id 对同内容 todo 撞 id → parsePlanSteps 返回 undefined → 计划更新静默丢弃（边界漏报，方向安全）。
- **m6**｜`plugin/hooks/sol-hook.mjs:247`：硬门只拦 Write|Edit（DESIGN 原文如此），MultiEdit 等其他变异类内置工具可绕过 gate——引导目的打折，建议 DESIGN/README 声明或补拦。
- **m7**｜`plugin/hooks/sol-hook.mjs:84-108`：persistedOutputPath 缺失时回退归档可能拿到 30k 截断的 stdout，账本将其记为全文（仅遥测，fail-open）。
- **m8**｜`plugin/scripts/verify-evidence.mjs:107` 缺省根 `…/data/sol-zcode` 与 `store.mjs:35` 的 `sol-zcode@sol-zcode-dev` 不一致（仅 ZCODE_PLUGIN_DATA 未设时可见）。
- **m9**｜`tests/integration/sol-edit-equivalence.test.mjs:125-134`：把 P1-5 的"写前读"测成了"文件必须存在"；内置 Read-before-Edit/Write 会话语义未复刻（已由 #11 偏差声明兜住，但应把该缺口点名给 P2）。
- **m10**｜`plugin/hooks/sol-hook.mjs:325-341`：类型错键在净全关状态下仍写 config_rejected 轨迹文件——DESIGN §3"全关=无任何副作用文件"与"记 config_rejected"内在冲突，实现取了可诊断侧；建议在 DESIGN 修订时把该子句改明确（"config_rejected 为唯一例外"）。
- **m11**｜`plugin/mcp/tools.mjs:405-435`：融合失败文本中适配层自加的 "Note: the file mutation above was applied…" 位于标记之后，会被回执一并替换吞掉（变异确认前缀仍在，影响轻微）。
- **m12**｜MCP server 侧不记 config_rejected（仅 hooks 记）——DESIGN §2.5/§3 未限定侧别；建议 server 启动时也补一条或声明。
- **m13**｜`plugin/hooks/hooks.json:6`：SessionStart matcher 含 "clear|compact"（0.16.5 不触发，与官方 example 同款写法；无害，G9 备案在案）。
- **m14**｜`plugin/hooks/lib/occ.mjs:216-227`：预算耗尽时 pendingCompactionReminder 永久滞留，仅靠后续自然 Stop 重置连续计数救回；会话总预算耗尽后提醒静默丢弃（方向安全，可加"过期清账"）。

### 记录在案（不扣分）

- commit message 的测试拆分 61+53 实为 62+52（总数 114 正确）。
- "full loop" 冒烟表述略强：开发方冒烟数据中 reducer objects=0（reducer 真实链路当时未跑通也未跑过）；本审核 V6 已独立补证其真实可用——不构成申报不实（P1 验收门不含真模型 e2e），但 P2 派单应把"reducer 真机对抗性 e2e"列为一等公民。
- 开发方冒烟会话遗留于真实 `~/.zcode`（sol-spike/sol-zcode 数据目录），属观测产物，未违反"安装/配置动作只经 install-plugin.mjs"的边界。

---

## 7. 扣分明细与评分

| 维度 | 权重 | 得分 | 依据 |
|---|---|---|---|
| 机制保真（vendor 1:1 + 适配按 DESIGN §2） | 30% | 9.5 | 15 文件逐行等价、常量/断言零漂移、SPDX/NOTICES 完整；扣适配层小纹（m2 缓存 key 占位模型、m11 注记行被吞） |
| 硬约束 C1–C4 | 30% | 8.5 | C1/C2/C4 主干全部独立实证通过；扣 M1（工具面枚举失实）、M2（C3 链完整性边界） |
| 测试真实性与覆盖 | 25% | 9.0 | 114 全绿且无假绿；并发链/篡改/协议/门控/防御断面齐；扣真模型与等价组缺口（m9）、guard-skip 路径仅单测薄覆盖 |
| 工程质量 | 15% | 9.0 | 锁/原子写/全链 fail-open/错误路径/回执可诊断性均好；扣 m1/m3/m4 竞态与串行化权衡、m8 不一致 |

**加权 2.85+2.55+2.25+1.35 = 9.0 → 最终评分 9.0 / 10。**

**验收门判定**：`node scripts/run-tests.mjs` 全绿 ✅；审核 ≥9.5 ❌（9.0）。**P1 不通过，需修复 M1、M2（预计 <30 行改动 + 2 条回归测试）后做 diff 级快速复审**；14 条 MINOR 建议随手修或在 DESIGN/README 偏差清单中声明，不阻塞。

---

## 8. 审核人备注（正面发现，供保持）

- 偏差申报的诚实度是本项目一贯强项：12/12 属实、每处在代码头与 THIRD_PARTY_NOTICES 双重留痕；"fail-safe 而非 fail-crash"的裁决（config_rejected、mcp-direct 回退、600s 阀）全部方向正确。
- 防护与证据链不是纸面设计：V5/V6 两项黑盒实测（篡改可抓、真机回执可过 validateReceipt）证明了 C3/C4 的实际效力，这在纯静态审核里是拿不到的置信度。
- 测试工程化程度高：fake-zcode 二进制同时充当协议探针（记录 argv/env/attach 字节数供防御断言）、3 进程并发链测试、逐字节 recall 还原断言——"协议级无模型测试"的方法论执行到位。
- 本审核新增的 V6（reducer 真机端到端）证明 ps 嗅探解析宿主二进制、--attach 传输、隔离 HOME、90s 超时、LRU、逐字核验在真实环境全部成立，为 P2/P3 扫清了最大的未知数。

---

# 复审（2026-09-13，整改核验）

- 对象：`e01ec42` "fix(P1): address audit findings (2 MAJOR + 11/14 MINOR)" + `cc443e0` "docs: fold audit m10 exception into DESIGN §3; add GOTCHAS G20"（工作树 clean；本报告 v1 文本经 diff 核对被原样提交，未被改动）。
- 方法：两 commit 全量 diff 逐行复核 → M1 名单对 zcode.cjs 运行时注册表独立重提取比对 → 复跑 `node scripts/run-tests.mjs`（124/124 全绿，61s）→ 复跑开发方复现脚本 `/tmp/m1-repro/check.mjs`、`/tmp/m2-repro/check.mjs` → **真机回归冒烟 1 次**（隔离 HOME + 真实模型走整改后的 reducer 全链路）。

## R1. 总体结论

**终评分：9.5 / 10 —— 通过 P1 验收门（≥9.5）。**

两个 MAJOR 均已正确修复且经独立双证（本审核复现 + 开发方可复跑脚本）；14 条 MINOR：10 条代码修复、2 条文档/裁决留置（m10 由文档 owner 补录 DESIGN §3 例外条款 + 代码内裁决说明）、1 条按审核建议点名 P2（m9）、1 条无害留置（m13）——处置全部与回执申报一致。未发现整改引入的新缺陷；vendor core 零改动（修复全部落在适配层）。

## R2. 逐条判定

| 项 | 判定 | 复核证据 |
|---|---|---|
| M1 denylist 漏 Cron×4/Task 族 | **已修复（双证）** | ① 本审核独立重提取 zcode.cjs 注册表数组 `["Agent",…,"Write"]` 共 31 名，与代码 "registered" 段**逐一相符**；② `/tmp/m1-repro/check.mjs` 实跑：registry 31 名 MISSING=(none)，真实子进程 argv 与 BUILTIN_TOOL_NAMES 逐字节一致，Cron×4 在 argv 中；③ 18 个曾缺失名族的逐名回归断言（reducer-pipeline.test.mjs）；④ GOTCHAS G20 回写注册表清单+版本升级复核指引（符合 PLAN"回写结论"要求） |
| M2 >64KiB 行断链 | **已修复（双证）** | readLastLine 自适应读窗（段起点 >0 ⟺ 行首在窗内，否则 4× 增长直至覆盖行首或全文件；逻辑复核无误，空文件/边界正确）；3 条回归复刻审核复现形状（73953B/82401B 行）；`/tmp/m2-repro/check.mjs` 实跑：旧算法取到碎片、新算法返回完整行，第二行 prevHash===第一行 hash、≠创世，verify ok |
| m1 粘 mcp-direct | 已修复 | `refreshToolContextSession` 每次 tools/call 重解析指针 + "指针晚于 server 启动"测试；注：指针出现前的写入仍落 mcp-direct（分裂归属），严格优于原粘滞行为 |
| m2 缓存 key 占位模型 | 已修复（测试典范） | `resolveHostModel` 实读宿主 config；3 连调用测试断言 cacheHit=false→true→（宿主换模型）→false |
| m3 全工具串行化 | 留置有据 | 代码内权衡说明（串行换链序确定性；跨进程本就有 O_EXCL 锁）——符合审核"宜记录"建议 |
| m4 跨进程 reducer-home rm 竞态 | 已修复 | per-runId 目录（`reducer-home-<uuid8>`）+ 1h 陈货清扫 + 并发双调用测试（both ok、零残留）；真机复跑 run/ 无残留 |
| m5 同内容 todo 撞 id | 已修复 | 出现序后缀 -2/-3 保持唯一、首例保持裸哈希 id；测试断言 id 序列。残留 nano 纹：同内容中 cancelled 项被移除后幸存者后缀会移位（按 payload 确定性，可接受） |
| m6 gate 漏 MultiEdit 等 | 已修复 | GATE_MUTATION_TOOLS={Write,Edit,MultiEdit,NotebookEdit,ApplyPatch} + 5 拦/5 放矩阵测试；Bash 不拦的裁量有注记（合理） |
| m7 截断冒充全文 | 已修复 | ledger 增 `source:"stdout"`/`possiblyTruncated:true` 溯源标记，双路径测试 |
| m8 缺省根不一致 | 已修复 | verify-evidence 改用 store.mjs `dataRoot` + 缺省根布局测试 |
| m9 "写前读"缺口 | 留置有据（按建议） | 测试改名 + 显式 gap-marker 断言（P1 契约=存在+精确匹配），点名 P2 |
| m10 config_rejected 例外 | **双重解决** | 代码内裁决说明 + DESIGN §3 补录例外条款（cc443e0，措辞与审核建议一致） |
| m11 Note 被回执吞 | 已修复 | Note 移至标记前（保留前缀），"约简后 Note 存活"测试 |
| m12 server 不记 config_rejected | 已修复 | server 启动记 `config_rejected`（source=mcp），与 hook 侧对齐 |
| m13 matcher 含 compact | 留置有据 | 与官方 example 同款、0.16.5 不触发，无害 |
| m14 提醒滞留 | 已修复 | 会话总预算耗尽→清账（连续预算暂时耗尽仍保留）+ 测试 |

## R3. 整改质量核验（新问题扫描）

- **测试**：114→124，新增 10 条全部瞄准审核项、无旧断言弱化（m9 改名是把误导性标题改诚实）；m2 缓存三段式与 m1 晚指针两条属高质量回归。复跑全绿。
- **vendor 完整性**：修复零触及 plugin/core/**（chain/occ/store 均为适配层），C1 零依赖不变（verify-evidence 新 import 为内部相对路径）。
- **真机回归**（V8）：隔离 HOME + GLM 真模型，整改后 reducer 全链路（44 名 denylist argv、per-run home、缓存 key 实模型化）candidate→applied 正常、run/ 零残留、verify 全绿——修复未破坏真实路径。
- **新引入问题**：未发现。两条记录在案的 nano 纹（m5 后缀移位、m1 分裂归属）均为确定性/方向安全，不构成缺陷。

## R4. 评分

| 维度 | 权重 | 得分 | 依据 |
|---|---|---|---|
| 机制保真 | 30% | 9.5 | vendor 零改动；修复均落在适配层且与上游不变式对齐（缓存 key 全要素恢复） |
| 硬约束 C1–C4 | 30% | 9.5 | M1/M2 关闭且双证；C2 例外条款已入 DESIGN；残余项均为设计已声明或留置有据 |
| 测试真实性与覆盖 | 25% | 9.5 | +10 条针对性回归、无弱化、复现脚本可复跑 |
| 工程质量 | 15% | 9.5 | 竞态关闭、归属健壮、陈货清扫、权衡留痕 |

**加权 9.5 → 终评分 9.5 / 10。P1 验收门通过，批准进入 P2。**

留给 P2 的在案事项（不扣门）：m9 真模型等价（含 Read-before-Edit 会话语义）；reducer 对抗性 e2e（建议加 Cron 注入向量，检验 denylist 实效）；UserPromptSubmit additionalContext 复检（G9 未决项）。
