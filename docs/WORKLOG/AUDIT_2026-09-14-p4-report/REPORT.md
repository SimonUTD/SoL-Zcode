# P4 阶段独立终审报告 — 正式五指标报告 + README 回填 + MINOR-5 修复

- 审核日期：2026-09-14（P4 收尾终审，轻量）
- 审核范围：最后 5 个提交 a07d7bf~1..e28f395（实际 4 个内容提交：a07d7bf P3 审核 report 落盘、0e2e9a5 MINOR-5 修复、ee46445 docs/REPORT.md 新建 170 行、e28f395 README 双回填）
- 审核对象：`docs/REPORT.md`、`README.md`、`benchmark/README.md`、`benchmark/agent/zcode_agent.py`（MINOR-5）、`docs/WORKLOG/AUDIT_2026-09-14-p3-probe/REPORT.md`（落盘完整性）
- 方法：只读逐位核对（源 usage.json → three-arm-note.md → REPORT.md → 双 README）+ 全部派生数字独立复算 + 两个测试套件复跑 + freeze manifest 解包核验
- 结论：**PASS — 9.5 / 10**

---

## 1. 总体结论

P4 收尾干净利落：正式报告的每一个指标数字与第一手证据（`benchmark/probe/*/usage.json`）及 P3 note 逐位一致，全部派生值（百分比、每请求均值、预算外推、时间和的舍入）独立复算通过；诚实性声明五要素齐全且与 P3 审核判定互证；README 回填无过度宣称、"进行中"字样全部清除；MINOR-5 修复与 P3 复审处方逐字对应且两套测试复跑全绿；freeze 完整性经 manifest 解包直接验证不受影响。唯一残留是一个继承自 note 的 nano 级表述歧义（"streak 1/3" 的语义标注，见 §3 NANO-1），不构成数字错误。

## 2. 核对结果（全部通过）

### 2.1 REPORT.md 数字逐位核对（对源、对 note、独立复算）

源数据（`probe/{arm1-recovered/control,20260913-200649/treatment,20260913-235742/gate}/usage.json`）与 REPORT.md §2 表逐位一致：

| 项 | A | B | C | 复算 |
|---|---|---|---|---|
| inputTokens | 8,805,055 | 5,980,884 | 3,505,890 | 一致；−32.1%/−60.2% 复算吻合 |
| cacheRead | 8,634,752 | 5,814,976 | 3,361,920 | 一致；占比 98.1/97.2/95.9% 吻合 |
| 非缓存 input | 170,303 | 165,908 | 143,970 | 减法吻合 |
| outputTokens | 123,711 | 145,749 | 133,157 | 一致；+17.8%/+7.6% 吻合 |
| USD | $0.3464 | $0.2722 | $0.1890 | 用附录 C 命令实跑 `cost_usd` → 0.346444/0.272210/0.189032，舍入吻合；−21.4%/−45.4% 吻合 |
| 墙钟 | 3,184 s | 3,668 s | 3,578 s | wallMs 3,183,834/3,667,699/3,577,641 舍入吻合；分钟换算吻合 |
| 请求数 | 77 | 50 | 30 | 一致；−35.1%/−61.0% 吻合 |
| reward | 1.0 | 0.0 | 1.0 | usage.json solved 字段一致 |
| 每请求 input | 114.4k | 119.6k | 116.9k | 除法吻合 |

派生数字复算：§6 预算表（$0.6186=0.3464+0.2722；6,852 s=3,184+3,668；63×$0.6186=$38.97→≈$39；63×6,852 s=119.9 h→≈120 h；÷4=30 h 理想）；§3.2 观察包（16,795−436=16,359 B）；§5.4（write+edit pre+post 15+22=37；bash 遵从 3/27）；§5.2 扣噪时长（(3,668−1,287)/60≈39.7→≈40 min；(3,578−1,897)/60≈28.0 min）——全部吻合。REPORT.md:8 "全部指标数字照录该 note，未做任何改动" 属实（§2/§3.5 表与 note §1/§2 逐格对照零差异；新增数字均为正确派生值或已声明出处的转述值）。

### 2.2 诚实性声明完整性

五要素逐条在位且有据：N=1（§0/§2/§5.1，"不支持任何统计显著性陈述"）；限速噪声（§2 口径说明+§5.2，1,897/1,287 s、扣噪时长、streak 判据可离线复算）；B 臂失败归因（§5.3，方案抽签非机制，N=1 下双向不可作因果解读）；软引导方差两极（§5.4，0 vs 21 次、run2 155 条全 native、bash 3/27）；全量未跑（§0.5/§5.5/§6，"63 题 × 双臂尚未执行"+管线就绪清单）。§4 对照表的来源声明块（"任务书与 SoL-OpenCode README.en.md:178-179 的转述，未能在 SoL-Pi 本地克隆或其 GitHub README 中溯源核实"）与 `docs/RESEARCH/sol-pi-mechanisms.md:64` 原始出处声明一致，五个转述数据点与 RESEARCH 两文档逐项核对无走样，口径差异说明（宿主/模型/tokenizer/计价/工具替换方式）在位。USD "列表价折算非发票" 在 §2/§4/§6 三处一致。

### 2.3 README 回填一致性

- 主 README：TL;DR 从 "in progress" 改为 "is complete"，明确 N=1 与 "full 63×2 run has not been executed"；基准结果表与 REPORT/note 逐位一致；gate 实测行为表述（1 次拦截→72 s 切换→100% 遵从、≈1.2 min）与 note §2/P3 审核 §2.2 一致；仓库结构行 "探针完成，全量待跑"；质量流程行补 P3 8.5→9.5 与附录 A 一致。`grep "进行中\|in progress"` 在三份文档零命中。
- benchmark/README：预算表五格与 usage.json 一致（含 both-default $0.6186/6,852 s/127=77+50）；¹ 注（21–32 min 节流、net ≈40/≈28 min）与 note 一致；两档外推与 REPORT §6 互为镜像无矛盾；"heavy-task N=1" 边界与 "budget to the table's ceiling" 提示在位。

### 2.4 MINOR-5 修复与处方一致性（commit 0e2e9a5）

- P3 复审处方："把 `_read_abort_marker` 提升挪到 payload None 早退之前（两路径共用）"。实测代码：`zcode_agent.py:452-465` marker 读取与 `meta["rateLimitAbort"]` 提升位于 `if payload is None:` 早退（:467-472）之前，payload-None 路径与正常解析路径（:493-500）共用同一段；原 payload-成功路径末尾的重复块已删除。纯位置挪动，无行为外溢（早退路径 exception 赋值次序不受影响）。
- 复跑：`python3 benchmark/bin/test-rate-limit-guard.py` → **26/26 PASS，exit 0**（含真实 C 臂 tgz 回放断言 1896.826 s）；`node scripts/run-tests.mjs` → **138/138 pass**。
- freeze 完整性：解包 `benchmark/freeze/manifest-3bbf74e68bc6.json`，其 hash 覆盖面为 plugin 树 28 文件 + zcode.cjs + node tarballs + providerTemplate + arms 选项 + tasks + pricing；`agent/zcode_agent.py` 与 `rl-watchdog.mjs` 均不在内——"freeze 不受影响" 的声称（commit message 与 REPORT 附录 A）属实。

### 2.5 P3 审核报告落盘完整性（commit a07d7bf）

`docs/WORKLOG/AUDIT_2026-09-14-p3-probe/REPORT.md` 175 行完整落盘：初审 8.5（MAJOR-1/MINOR-1~4 带 file:line 证据）+ 数据链核实三节 + 审核命令附录 + 复审节（diff 4b5878a..43ba9e5，MAJOR-1 四层落地核实、MINOR-1/2/3 整改核实、MINOR-5 新发现与修法、终评 9.5）。REPORT.md 附录 A/B 对它的引用（评分轨迹、"每一个数字都通过了独立复算"引文）准确无走样。

## 3. 问题清单

### NANO-1（继承）："streak 1/3" 语义未标注，CLI 摘要行不显示该值

- 位置：`docs/REPORT.md:56`（§2 口径说明）与 `docs/REPORT.md:160`（附录 C 注释）；源头 `benchmark/probe/three-arm-note.md:88`。
- 证据：照附录 C 命令实跑 `python3 benchmark/rate_limit_guard.py benchmark/probe/html-js-filter-20260913-235742/gate/sol-data.tgz`，输出 `streak=0/3 maxRequestGap=1896.826s`——CLI 摘要行打印的是**尾部** streak（`rate_limit_guard.py:255`，`verdict['streak']`=trailing），而注释里的 "1/3" 是 **maxStreak** 语义（实跑 verdict：`trailing streak: 0, maxStreak: 1`，即中途最大连续 1 次超限、随后被重置）。两个值都真实存在、结论同向（均 <3 → 不中止），但复算者按注释跑命令会看到 `streak=0/3` 与注释 "streak 1/3" 字面不符，需读 `rate_limit_guard.py:192-206` 才能消解。P3 复审已见过此写法并按 maxStreak 语义放行；P4 照录 note（其"照录不改"纪律反而锁定了该歧义）。
- 建议（可留待全量跑批前顺手做）：CLI 摘要行加打 `maxStreak`，或两处注释改写为 "maxStreak 1/3（尾 streak 0）"。
- 影响：无不正确结论，无数字错误；仅复算体验上的歧义。

### 观察（不计分）

- REPORT §6 与 benchmark/README 的 "~$0.08–0.12/任务臂"（转述上游单臂成本区间）：上游实际两臂 $0.0826/$0.1249，上界 0.1249 舍作 0.12 略低；有 "~" 号且用途仅是"本题偏重"的反衬，非错误。
- REPORT §2 正文与附录 C 的 rate-limit-guard 命令分别按 benchmark/ 与 repo 根两种隐含 cwd 书写相对路径，每条命令自身自洽，不构成问题。

## 4. 评分

**9.5 / 10 — PASS P4 收尾。**

- 数字保真（源→note→REPORT→README 四级零走样 + 派生全复算 + 附录命令实测可复现）：满分档。
- 诚实性（五声明 + 转述溯源声明 + 口径差异 + 非发票声明）：完整，与 P3 审核判定互证。
- MINOR-5 修复：与处方逐字对应，26/26 与 138/138 复跑绿，freeze 不受影响经 manifest 直接验证。
- 扣 0.5：NANO-1 表述歧义虽属继承且极轻，但出现在两处正式报告的"可复算"指引里，与本项目"复算者所见即注释所写"的基准不符；记 0.5 以保持与其他阶段同口径的严格度（若按其对结论的实际影响计，接近 0）。
