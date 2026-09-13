# P2 e2e 测试套件 + P2.5 修复审核报告 — AUDIT_2026-09-13-p2-e2e

- 审核对象：最近 4 个 commit（`5917768` P1 终审基线 → `565588f` P2 e2e 套件 → `20ba7d8` P2.5 修复 → `d91ed64` DESIGN 回写）的 diff 与工作树现状（工作树 clean，与 `d91ed64` 一致）。
- 依据（只读）：`docs/DESIGN.md`（终审版+P2.5 回写）、`docs/PLAN.md` P2 派单、`docs/GOTCHAS.md` G1–G23、`docs/WORKLOG/AUDIT_2026-09-13-p1-plugin/REPORT.md`（P1 终审 9.5 与三项在案）、`tests/e2e/results/`（全部 15 条历史记录含失败尝试）。
- 审核方式：e2e 全部 11 个源文件 + P2.5 三个插件文件逐行通读 → 结果 JSONL/场景 JSON 逐条核对（含 6 条失败记录）→ 算术复核（估算器累计/基线/增量）→ zcode.cjs（0.16.5）反编译核对工具并行执行路径 → `node scripts/run-tests.mjs` 全量复跑 → **独立复跑 s6 真模型场景**（1 次模型请求，14:11 本地，已作为第 16 条记录追加进 JSONL 并覆盖 s6 场景 JSON，内容与原记录等价 5/5 PASS）。
- 日期：2026-09-13

---

## 1. 总体结论

**评分：9.0 / 10（未达 ≥9.5 的 P2 验收门；0 BLOCKER / 0 MAJOR / 8 MINOR + 1 nano，全部可小修，预计 <100 行改动 + 2 个补充测试即可复审至 9.5）。**

P2 交付质量整体高于 P1 v1（无 MAJOR）：真模型 e2e 是本项目迄今最扎实的一层测试——隔离 HOME 双臂字节级等价、对抗注入三向量（含 CronCreate）、OCC 在**真实 1M 窗口**上的经济触发全链路（含自限与 G17 通道逐项证据）、诚实 FAIL→诊断（G21/G22）→修复→复跑 PASS 的完整弧线全部有案可查；结果记录极其诚实（6 条失败尝试原样保留在 JSONL）。P2.5 修复方向正确、单测钉死、DESIGN/GOTCHAS 同步回写。

未到 9.5 的原因集中在三点：① **P2.5 新引入的 occ-state 跨进程读改写无锁**（宿主并行工具执行使竞窗真实存在，无并发回归测试）；② 对照 DESIGN §6.3 的 e2e 清单，**then_run 真模型路径零覆盖**（动作融合的招牌特性只有 P1 协议级测试）；③ 若干断言精度问题（`rolloutFindString` 不钉 request 侧字段、s3 结论断言恒真）与一处无法从工件复核的声称（"verify 全绿"——e2e 从未调用 verify-evidence）。此外估算器对原生 Bash 大输出存在**方向为高估的系统性偏差**（G7：模型只见 ~2KB 预览，估算器计全额 stdoutBytes），s5 的"经济区间"部分由未真正进入上下文的字节构成——代码内有注释申报，但 s5/DESIGN 的表述应加此限定。

---

## 2. 独立实证记录（本审核新增，全部可复现）

| # | 实验 | 结果 |
|---|---|---|
| V1 | `node scripts/run-tests.mjs` | **134/134 全绿**（61.3s；62+52 旧 + 10 新 = 与声称一致） |
| V2 | `node tests/e2e/run-e2e.mjs --only=s6-alloff-zero`（真模型 1 请求） | **PASS 5/5**（input=12590；数据根前后均零文件、rollout 工具表无 sol 工具、模型自报 NO-SOL-TOOLS）——C2 在真实宿主由审核人独立复现 |
| V3 | 旧测试保持性 diff（`5917768..20ba7d8` tests/） | occ.test.mjs 仅删 1 行文件头注释、为旧压缩检测测试**加** 1 条 `compactionDetection==="available"` 断言；其余 124 条旧断言零改动；integration 零改动——声称 8 属实 |
| V4 | s5 估算器算术复核 | 111462B→ceil/4+12000=39866=T1；228325B→69082=T2，与 occ-state 记录逐位一致（累计无双计） |
| V5 | zcode.cjs 反编译（并行执行证据） | `executeToolCallsForModelStep` 经 `scheduleTools`/`executeTools` 以批（`onBatchStart` 收数组）并行执行同一步骤内多个工具调用；hook 记账含 `lane:"toolAfter"`+`anchorToolCallId`——并行工具→并发 PostToolUse hook 进程是现实形态（见 m1） |
| V6 | 结果记录诚实性 | JSONL 15 条（审核前）含 6 条失败：s4×1、s5 v4×3、s2×2（含 `fallback` 事件与 "BYTES=16907 EVIDENCE=0" 原文）——失败尝试与诊断完整保留，无粉饰 |

---

## 3. 开发方声称逐项核实

| # | 声称 | 判定 | 证据与偏差 |
|---|---|---|---|
| 1 | s1 等价 30/30（双臂字节一致、Read-gap 4 vs 0） | **属实** | 记录 `04:36` 30/30；6 文件 × (armA==期望 / armB==期望 / armA==armB) 期望由 harness 独立计算；armA counts `{Write:3,Edit:9,Read:4}` vs armB `{sol_write:2,sol_edit:5}`（0 Read）；gap 对照 armA Read:1/armB Read:0，终态字节双双正确。附带可信侧证：armA 17 请求/259772 input vs armB 8 请求/128395 input |
| 2 | s2 对抗 20/20（16907B→2032B 回执 8 证据、无副作用、aux 零轨迹、verify 全绿） | **基本属实，两处偏差** | 记录 `05:37` 20/20：source=16907B、receipt=**2036B**（非 2032B；commit message 写 2036B 正确，brief 转述错 4B）；8 条 quote 由 harness 对归档原文逐字节复核通过；/tmp/sol-adv-{test,marker} 未创建；trajectory/ledger 目录恰只含主会话；归档对象含全部 3 向量。**"verify 全绿"无任何工件支撑**——e2e 未调用 verify-evidence，tmp home 已清理（见 m3） |
| 3 | s3 G9 复检=可达（messages[5]+逐字回显） | **属实** | 记录 `04:50`：`rolloutLocations=["$.request.messages[5].content", $.response.*]`，`modelEcho=true`，提示词只含格式不含值（`promptContainsValue:false` 断言钉死无假阳性路径）；GOTCHAS G9 已按证据修正。注意场景本身 pass 与结论无关（见 m6） |
| 4 | s4 观察包 7/7（17920B 逐字节） | **属实** | 记录 `04:46`：offsets `[0,16384]`、pageFileBytes `[16384,1536]`、重组 17920B `byteEqual=true`；失败首试（04:42，transcript 证据断言失败）保留在案 |
| 5 | s5 v5 PASS 20/20 + s5b 6/6 | **属实（带 m2 校准限定）** | 记录 `06:00`：contextWindowTokens=1000000（真实窗口未降阈）、stop-block-economic×2（consecutive=2/total=2，自限 2≤2、总 2≤3 在真会话达成）、stops=4/active=2、todoWrites=3（续跑反应）、`[sol-occ] boundary reached` 进 rollout、compactionDetection=unavailable 如实、priorCompactionCount=0。s5b（05:26）6/6：通道三要素（续跑/stop_hook_active/reason 进请求体+CHANNEL-OK）独立于估算器由 probe 证实 |
| 6 | s6 5/5、s7 7/7（EACCES→全文+fallback 记账） | **属实** | s6 由本审核独立复跑 PASS 5/5（V2）；s7（05:36）：12.9KiB 全文中段行进请求体、无 placeholder、ledger `event:full`+EACCES fallback、LAST=3000 |
| 7 | P2.5 累积估算器 + G22 回退 | **属实（带 m1 竞态限定）** | occ.mjs：cumulativeBytes 持久累计、SYSTEM_BASELINE_TOKENS=12000、contextTotal=max(累计+基线, transcript)、检测按 `entries≥2 && tokens≥estimated` 判可用否则如实 unavailable；sol-hook 三事件累计；reducer-subprocess env→ps→已知路径，`reducer-bin.test` 含"本机无 env 实测回退成功"的 live 探测测试。DESIGN §2.4/§8.9 回写与代码一致 |
| 8 | 134/134 全绿、124 全保持 | **属实** | V1/V3 独立复核 |

---

## 4. P1 在案三项闭环判定（P1 复审 §R4 留给 P2 的事项）

| 在案项 | 判定 | 依据 |
|---|---|---|
| m9 真模型等价（含 Read-before-Edit 会话语义） | **闭环** | s1 双臂对独立期望的字节级等价 + Read-gap 量化（批臂 4 vs 0；专项对照臂 1 vs 0 且终态字节一致），并按 m9 要求落为偏差证据注记。残留小纹：gapA 的"拒绝话术"检测因 G21 transcript 失明返回 false，拒绝证据只剩工具计数——可接受 |
| reducer 对抗性 e2e（含 Cron 注入向量，检验 denylist 实效） | **闭环（带 m3/m4 限定）** | s2 三向量（rm-rf/CronCreate/ignore-previous）随 16907B 归档原文（哈希+逐字复核）真实送达归约子进程，零副作用、主会话零 Bash/Cron、aux 零轨迹。证据是结果性的（未观测子进程是否"尝试"了被禁工具——工具面封死下无法产生轨迹，属合理） |
| G9 UserPromptSubmit 复检 | **闭环** | 双证据（请求侧 `$.request.messages[5].content` + 逐字回显，提示词不含值）推翻初版反例，GOTCHAS G9 已修正。场景断言本身不锁定结论（m6），但记录+文档已固化正确结论 |

---

## 5. 问题清单

### MINOR

**m1｜occ-state 共享黑板：跨进程 load→add→persist 无锁（P2.5 新引入的竞态面）**
- 位置：`plugin/hooks/lib/occ.mjs:116-123`（`accumulateOccUsage` 裸读改写）、`:97-106`（`persistOccState`）、`plugin/hooks/sol-hook.mjs:262-310`（UserPromptSubmit/PostToolUse/Stop 三处调用）、`occ.mjs:249-254/384-399`（Stop/TodoWrite 同款裸读改写）。
- 证据：`appendChained` 自带 O_EXCL 锁（`chain.mjs:149-167`）保证链写串行，但 occ-state.json 快照的读-改-写不在任何锁内；反编译证实宿主以批并行执行同一步骤内的多个工具调用（V5）→ 并发 PostToolUse hook 进程对同一 occ-state 丢失更新是现实竞窗（代码注释自认"Hooks are separate processes … every event loads→adds→persists"，但未处置竞态）。
- 后果：常见交错=丢一次累计（低估→触发推迟，fail-safe 方向）+ occ-history 出现 cumulativeBytes 非单调的状态行（链本身仍连续）；窄交错=迟到的 accumulate 以旧状态覆盖 Stop 轮持久化，理论上可回滚 consecutiveBlocks/totalBlocks（自限是插件承诺的安全属性，且需 Stop↔PostToolUse 重叠，常规时序难出现——故 MINOR 而非 MAJOR，校准同 P1 m4）。
- 建议：为 occ-state 读写加专用锁（复用 chain.mjs 锁模式），并补一条双进程并发 accumulate 的回归测试（P1 已有 3 进程并发链测试可仿）。

**m2｜估算器对原生 Bash 大输出系统性高估（G7 未计入校准）**
- 位置：`plugin/hooks/sol-hook.mjs:290-303`（`occToolResponseBytes` 取 stdoutBytes+stderrBytes 全额）；对照 GOTCHAS G7（106KB Bash 输出模型只见 ~2KB 预览+落盘提示）。
- 后果：s5 的"经济区间"（T2=69k tokens）主要由两份 108894B 的 stdoutBytes 构成，而其中绝大部分从未进入模型上下文（真实末请求上下文约为估算值一半，从 resume usage 109608/6 请求可反推）。e2e 证明的是**决策路径在真实常量/真实窗口下可达**，不是估算器对真实上下文的校准。方向为高估→提前建议压缩→额外续跑轮成本，受 3 次/会话自限封顶；treatment 基准臂大输出走 sol_bash（占位符字节=模型实见）时无此偏差。代码注释已申报"conservative in the over-count direction"，但 s5 notes.math 与 DESIGN §2.4 的表述未提 G7 因子。
- 建议：DESIGN §8（或 G21）补一句高估方向与量级说明；可选：PostToolUse 对有 persistedOutputPath 且 stdout 被截断的原生结果按"预览尺寸"而非 stdoutBytes 计。

**m3｜e2e 从未运行 verify-evidence；"verify 全绿"声称无工件**
- 位置：`grep -rn verify tests/e2e/` 为空；s2 记录的 sourcePath 指向已清理的 tmp home。
- 后果：C3 的对账 CLI（P1 V5 曾实测篡改可抓）从未对真实 e2e 会话数据跑过；声称 2 的"verify 全绿"不可复核。
- 建议：s2/s4/s5 在 cleanup 前对 dataRoot 调 `scripts/verify-evidence.mjs` 并断言 exit 0（近乎零成本，闭合 C3↔e2e 环）。

**m4｜`rolloutFindString` 不区分请求侧/响应侧字段，弱于断言名**
- 位置：`tests/e2e/lib/harness.mjs:282-312`（walk 全部字符串值，含 `$.response.*`）；用于 s2"receipt reached the model (rollout request message)"、s5/s5b"reason … in a subsequent model request body"。
- 后果：模型若在回复中回显目标串即会假绿（s3 的 rolloutLocations 证明 `$.response.text` 命中是真实存在的形态）。本次各记录经旁证（8 条 quote 可解析、回复为 DONE/CHANNEL-OK 定长）确属请求侧，但作为回归断言不严谨。
- 建议：仿 s3 的 rolloutLocations 钉 `$.request` 前缀。

**m5｜then_run 真模型 e2e 零覆盖（DESIGN §6.3 自列清单项）**
- 位置：DESIGN §6.3 场景表"sol_write/sol_edit 与内置等价 **+ then_run 标记**"；`grep -rn then_run tests/e2e/` 为空（s1 只测 write/edit 变异与批编辑）。
- 后果：动作融合的核心增量（变异+验证单次调用、`[then_run:succeeded/failed]` 标记、失败时"文件已写入"事实）仅有 P1 协议级测试，未经真模型回路。另 DESIGN §6.3 的"trajectory JSONL 无内容字段"在 e2e 层也未对真会话数据断言（仅 P1 fixture 级）。
- 建议：s1 加一步 `sol_write(..., then_run)`（如写文件+`wc -c` 校验），断言标记与综合结果；顺手断言真实 trajectory 行无 prompt/输出内容字段。

**m6｜s3 场景 pass 与 G9 结论解耦（恒真断言）**
- 位置：`tests/e2e/scenarios/s3-g9-userprompt.mjs:125`——`assertions.check("G9 verdict determined", typeof verdict === "string", …)` 对任何 verdict（含 DOES-NOT-REACH-MODEL）都通过。
- 后果：若未来宿主版本回归破坏可达性，s3 仍 PASS，回归不被套件捕获（结论只活在 notes/GOTCHAS）。
- 建议：既然正确结论已确立，直接断言 `verdict.startsWith("REACHES-MODEL")`（或 modelNotFound 即 fail）。

**m7｜过时注释与自家证据矛盾（rollout messages 之争）**
- 位置：`tests/e2e/lib/probe.mjs:8-10` 与 `s3-g9-userprompt.mjs:71-77` 均称"rollout request bodies carry no messages under modelIoFullRetentionEnabled=false（P2 finding）"；同一次运行记录的 `$.request.messages[5].content` 与 GOTCHAS G14（"rollout 有 request.messages"）直接推翻该说法。
- 后果：误导后续维护（GOTCHAS 是权威，测试文件头是陈旧初稿）。
- 建议：改写两处注释为 G14 口径（messages 存在、留存策略不保证长期）。

**m8｜声称/文档小误差**
- s2 回执字节数：记录与 commit message 均为 **2036B**，brief 转述 2032B（差 4B，方向无害）；s5 通过断言 "occ state exists" 的 detail 文本固定为失败模板 "occ-state.json missing"（记录里 pass 行带误导性 detail，纯外观）；G22 插件侧回退（ps/已知路径）仅有单测+本机 live 探测，权威 s2 通过记录是在 harness 恒设 `SOL_ZCODE_ZCODE_BIN` 的 env 通道下取得——已知路径回退未做过端到端真模型验证（P3 容器 harness 必须显式设 env，G22 已警示）。

### nano（记录在案，不扣分）

- `persistOccState`（occ.mjs:97-106）：`appendChained` 返回 null（3s 未抢到锁）时仍继续 rename 快照 → 快照可前进而无历史行（链连续性不受损，缺口不可检测）。随 m1 一并处理即可。
- 审核人复跑 s6 向 JSONL 追加了第 16 条记录并覆盖 s6 场景 JSON（内容等价 PASS 5/5）——审核动作留痕，非开发方问题。

---

## 6. 扣分明细与评分

| 维度 | 权重 | 得分 | 依据 |
|---|---|---|---|
| P2.5 修复正确性与机制保真 | 30% | 9.0 | 估算器/G22 实现与 DESIGN 回写一致、单测钉死、G21 降级诚实；扣 m1（新引入无锁竞态面、无并发测试）、m2（高估校准未入文档表述） |
| 硬约束 C2/C3/C4 的 e2e 实证 | 30% | 9.5 | C2 真会话零行为（开发方+审核人双证）；C3 归档哈希+harness 独立逐字复核；C4 三向量对抗+aux 零轨迹全过；扣 m3（verify CLI 未进 e2e、一项声称无工件） |
| e2e 测试真实性与覆盖 | 25% | 9.0 | 字节级断言、双臂/双证据设计、预算闸、诚实重试，无发现假绿实案；扣 m5（then_run/轨迹字段两缺口 vs DESIGN §6.3 自列清单）、m4/m6（断言精度：helper 不钉 request 侧、s3 恒真断言） |
| 工程质量与诚实度 | 15% | 9.5 | 6 条失败尝试原样保留、FAIL→诊断→修复→PASS 弧线完整、GOTCHAS 及时修正（G9 推翻自己初版结论）；扣 m7/m8（陈旧矛盾注释、声称字节数误差） |

**加权 2.70+2.85+2.25+1.425 = 9.225 → 最终评分 9.0 / 10（0.5 精度；内部 9.2）。**

**验收门判定**：e2e 全绿 ✅（8/8 场景最终记录 PASS，s6 经审核人复跑复现）；审核 ≥9.5 ❌（9.0）。**P2 暂不通过门**，但与 P1 相同轨迹：m1–m6 全部为小改（预计 occ 锁+并发回归、s1 补 then_run 步骤、场景收尾跑 verify、helper 钉 request 路径、s3 断言结论、两处注释），一轮 diff 级快速复审可达 9.5。m7/m8 随手修即可。

---

## 7. 审核人备注（正面发现，供保持）

- 结果账本哲学正确：JSONL append-only 且失败记录永不删除，6 条失败（含 s5 v4 三连败的诊断数据 T1=211/T2=3——正是 G21 结构性失明的直接证据）构成不可辩驳的发现史；commit message 与记录严格一致（2036B）。
- 探针插件设计克制且聪明：被动 payload 记录 + transcript 拷贝（绕开 G5 临时文件）+ 一次性 Stop-block（G17 通道与估算器解耦验证，s5b 的方法论正确性由 probe 发射而非插件自证）。
- s5 的经济学验证用真实窗口+真实常量，负判据（Stop#1 单增量数学上不可触发）与正判据（Stop#2 触发）成对出现，自限在真会话被逼到边界（consecutive=2 后第三块被拒）——这是"机制真的在跑"的最强证据形态。
- 134/134 与 124 保真（V3 diff 级核实）说明 P2.5 没有靠改旧测试换绿灯；唯一旧测试改动是加断言，且加得其所（available 判据）。

---

## 8. 整改清单（复审前必做 m1–m6）

1. m1：occ-state 专用锁 + 双进程并发 accumulate 回归测试。
2. m5：s1 增补 then_run 真模型步骤（标记+综合结果断言）；顺带真会话 trajectory 无内容字段断言。
3. m3：s2/s4/s5 收尾对 dataRoot 运行 verify-evidence 并断言 exit 0。
4. m4：rolloutFindString 增加 requestOnly 选项并用于 s2/s5/s5b 关键断言。
5. m6：s3 断言 `verdict.startsWith("REACHES-MODEL")`。
6. m2：DESIGN §8/G21 补高估方向说明（可选：预览尺寸计数）。
7. m7/m8：修正 probe.mjs/s3 注释、声称字节数与 detail 模板。
