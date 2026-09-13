# 研究底稿：SoL-OpenCode（ImKK666/SoL-OpenCode @ ./sol-opencode）移植方案

> 来源：Explore 子代理 2026-09-13 通读约 3200 行 TS + benchmark 脚本 + 文档。

## 1. 结构
Bun workspaces：`packages/core`（@alicekk/sol-opencode-core，纯逻辑零依赖仅 node:*，1596 行，MIT+NVIDIA SPDX 头）+ `packages/opencode`（插件本体 1562 行）+ `apps/e2e`（mock/真模型 A/B）+ `apps/bench`（dev 套件 + held-out 纪律 + TB4）。
注册顺序刻意（index.ts:29-31 注释）：trajectory → actionFusion → **reducer → observationPack**（reducer 的 after 处理器先执行，小回执永不被 OP 打包）→ onlineContextCompact。发布不编译，直接 TS 源。

## 2. 五机制实现（core=可整体复用，adapter=按宿主 API 重写）
- **Action Fusion**：core（then-run.ts 标记常量/双 sha256+setImmediate 守卫/runThenRun 注入式 runCommand；file-queue.ts realpath 回溯+promise-tail）原样可复用。adapter：`tool.definition` 注入手写 JSON Schema（OpenCode 内置工具是 Effect Schema，唯一通道是 jsonSchema 字段）；`tool.execute.before` **原地 delete args.then_run**（同引用传播）；`tool.execute.after` 执行命令+把标记输出**追加**到 output.output（绝不把整次调用标错）。
- **ObservationPack**：core（observation.ts 常量同上游/id=sha256(tool\0callId\0contentHash)[0:24]/ensureStored O_EXCL 复验/确定性占位字节/整行摘录/字节级 searchObservation（20 条上限，UTF-8 边界安全）/readRecallChunk 双限）原样可复用。adapter：`tool.execute.after` 归档（优先 metadata.outputPath 全文）；元数据盖进 output.metadata（持久化到消息 part）；**`experimental.chat.messages.transform` 投影**：`countAssistantAfter(messages,index) < fullSends` 跳过（无状态发送计数，resume 安全）；obs_recall{id,offset?,query?≤256B}。自有工具豁免 {obs_recall,sol_trajectory}。
- **EPR**：core（config 正则集/policy 四道门+缓存 key（storeRoot+archiveHash+command+isError+provider+model+schema+instructions）/archive/receipt（同上游核验全套+authority/readback 行）/LRU(64) 命中 usage 归零）原样可复用。adapter：bash+DIAGNOSTIC_COMMAND 触发；isError=metadata.exit!==0；流水线门→归档→缓存→模型→校验→receipt-not-smaller→journal applied→**原地替换 output.output**；一切失败 journal fallback+原文放行。**模型传输=子会话**：`session.create({parentID,title:"sol-reducer"})`→`session.prompt`（内联 system=reducerInstructions、tools:{} 禁用工具、指定 provider/model）→超时 race→info.tokens 提 usage→finally `session.delete`；凭证不进插件。
- **OCC**：core（economics.ts/plan.ts 逐行同上游）原样可复用。adapter：请求 tick=自己的 messages.transform 里数 token（chars/4）+增量滑窗(20)；计划源=**原生 todo.updated 事件**→todosToPlan（cancelled 跳过）；决策点=session.idle；三重防循环（boundary 用后即焚/inFlight/maxAutoContinuations=3）；通过→`client.session.summarize`；`experimental.session.compacting` hook 注入边界压缩指令文案；状态持久化 state.json。与 DESIGN 的偏差：没做 autocontinue 续跑，只做"决策+触发+指令注入"（更保守）。
- **Trajectory**：core（store.ts 环形缓冲 maxRecords=12/label≤96/detail≤64/剥 ANSI；jsonl.ts 批量非阻塞 append（promise 链串行化），写失败仅记一次日志并吞掉——"可观测性绝不能改变 agent 行为"）原样可复用。adapter：单一 event hook 扇出全部生命周期事件；message.updated 用 seenMessages Set 去流式噪声；工具 span=before(running)+after(status+durationMs)；`sol_trajectory` 工具导出最近 N 条；CLI bin/sol-trajectory.mjs（sessions/show/tail）。**绝不落盘**提示词/assistant 文本/工具参数/工具输出（SECURITY.md:24-26）。

## 3. 移植策略（Pi 内核能力 → OpenCode 插件 API 映射，Zcode 同理参照）
| Pi 依赖 | OpenCode 等价物 | Zcode 对应（本项目） |
|---|---|---|
| pi.on("context") 投影 | experimental.chat.messages.transform | ❌ 无 → 包装工具立即占位 + SessionStart 引导（G7/G9） |
| pi.on("tool_result") 改写 | tool.execute.after 原地改 output | ❌ 无 → 只能遥测/归档原生输出；自有工具内闭环 |
| pi.registerTool | tool hook 返回 ToolDefinition | ✅ MCP server tools/list（G11） |
| 改内置 edit/write schema | tool.definition jsonSchema 注入 | ❌ updatedInput 重校验 → sol_write/sol_edit 包装工具 + exit-2 引导门（G8） |
| context.compact() | client.session.summarize + compacting hook | ⚠️ 无触发 API → 依赖原生 autoCompact + SessionStart(compact) 提醒注入（G9） |
| turn_end/agent_settled | session.idle 事件 | Stop hook |
| before_provider_request 计 token | 自己在 transform 里数 | Stop/PostToolUse hook 估算 + transcript |
| modelRegistry+auth 直调 | 子会话 session.prompt | headless `node zcode.cjs --prompt` 子进程（G1/G2，凭证/模型仍归宿主配置） |
| 生命周期事件+TUI | 单一 event hook + JSONL + 工具 + CLI | hooks 事件 + trajectory JSONL + sol_trajectory 工具 + verify CLI |

适配层骨架（可抄）：Kernel（input/config/sessionRoot/isAuxSession 防重入标记/log stderr）；HookBus（注册序扇出，**每处理器独立 try/catch**，机制 bug 只 log；无处理器不挂 hook=零注册）。

## 4. opt-in 门控
`parseConfig(options)`：每个机制 `readBoolean` 非 boolean 一律 false；缺 key=false。index.ts 五个 if 才 register。测试钉死"全关→hooks 对象 0 键"。默认值：thresholdBytes 10240/fullSends 2/cacheWriteReadRatio 12.5/keepRecentTokens 20000/maxAutoContinuations 3/maxRecords 12/fusion tools [edit,write]。约束：OpenCode 的 `compaction.auto:false` 是 OCC 前提（插件不能代设）。

## 5. 防篡改（分层，全部有代码落点）
① 原文永不清除（归档先于替换；回执带 source_artifact+readback）；② 逐字节核验（quote includes/source_sha256/status 一致/missing-failure-evidence 反洗白）；③ 内容寻址+独占创建+复验（不一致=integrity failure）；④ untrusted 隔离（提示词声明+包裹+子会话禁工具）；⑤ LIKELY_SECRET 门+reducer 默认关；⑥ 防自吞噬（receipt 前缀跳过打包+注册顺序双保险+receipt-not-smaller+缓存 key 全覆盖）；⑦ append-only 审计（journal/ledger/trajectory）；⑧ fail-open 全链；⑨ 基准防作弊（append-only ledger+一次性冻结+源码哈希）。

## 6. 基准方法（四层）
1. 确定性 mock A/B：进程内 OpenAI 兼容 mock 记录每个请求体；按 tool-result 数选剧本轮次；能识别 reducer 子会话请求并回放可过校验的回执；隔离 HOME/XDG/config；指标=请求数/prompt 字符/tool 字符/max 请求。
2. 真模型 A/B：每轮每臂独立工作副本+独立 HOME（只播种 models/auth）；token/成本从 step_finish 事件解析；成功=独立跑测试套件；N 轮取中位数。
3. dev 套件：可验证任务（fail-before/pass-after verifier）+双臂+**能力地板门控效率胜利**（solved 不降 且 cost 下降才 ADMISSIBLE）。
4. held-out 纪律 + TB4：freeze manifest（包名+版本+**插件&core 源码树逐文件 sha256**+机制配置+模型+评测集哈希，不可变）；五道守卫（held-out 已声明/dev 与 held-out 不相交/**候选漂移即拒跑**/**一次冻结只评一次**/评测集不可变），守卫有测试钉死；append-only ledger 只追加，report 只从 ledger 派生；TB4 接入=Harbor + opencode agent + config overlay（两臂唯一差异=overlay 是否带插件，treatment 钉死冻结版本号）；`--probe` 不写账不烧 one-shot；63 题中 3 GPU 题排除。

## 7. 可复用模块清单（对 Zcode 移植）
core 全部原样（MIT+SPDX）：economics/plan、observation、reducer/{receipt,archive,cache,policy,config}、trajectory、then-run/file-queue、ledger。插件骨架模式（Kernel+HookBus+隔离测试）方法论级复用。基准基建（freeze/one-shot/ledger/sourceHash 与编辑器无关）方法论复用。需按 Zcode API 重写：仅 adapter 层（本项目的 hooks 脚本+MCP server）。

## 8. 实测数据（README/DESIGN 记录）
- mock A/B：observation-pack 工具输出字符 −58.7%；action-fusion 请求 −33.5%；reducer 工具输出 −95.1%。
- 真模型 A/B（deepseek-v4.1-flash，N=5 中位，单任务）：总 tokens −50.3%（26617→13228）、成本 −43.6%（$0.0044→$0.0025）、成功率 1.0→1.0、**墙钟 +136%（10.4s→24.5s，reducer 子会话的真实代价）**。
- dev smoke：tokens −61.5%/cost −59.1%/ADMISSIBLE。
- TB4 探针（html-js-filter，N=1）：input 11.4M→4.4M（−61.3%）、成本 $0.1249→$0.0826（−33.9%）、墙钟 −19.0%、异常 0/0、两臂 reward 均 0（能力未证明，仅证机制在真实基准可用；treatment 容器日志 8 次 sol 命中含 reducer 回执）。成本 ~$0.08/任务，全量 63 题 ~$10，瓶颈 ~30 分钟/题。
- 诚实结论：token 降幅量级与上游相当但口径不同，只作方向性 sanity；能力代价（上游 ~94%）在移植中未测量。
