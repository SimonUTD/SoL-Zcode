# SoL-Zcode

> Porting NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi)'s **five surviving token-efficiency mechanisms** into an independent [ZCode](https://zcode.z.ai/) plugin — public plugin APIs only, explicit opt-in, evidence-preserving.

**English TL;DR** — This repo contains `sol-zcode`, a ZCode plugin that ports the five mechanisms SoL-Pi's automated research retained (action fusion, observation packs, evidence-preserving reducer, online context compaction, trajectory inspector). It uses only public plugin APIs (MCP tools + hooks), is disabled by default until explicitly opted in, keeps every original observation on disk in a tamper-evident hash-chained ledger, and leaves auth / provider URLs / model selection / shell semantics to ZCode. Design was audited to 9.5/10; implementation passed 138 unit/integration tests plus 9 real-model e2e scenarios (including prompt-injection adversarial tests). A Terminal-Bench 4 three-arm probe (control / treatment / gate, GLM-5.3-Flash, single task, N=1) is complete: treatment −32.1% and gate −60.2% input tokens vs control, savings driven by request-count collapse (77→50→30); the full 63×2 run has not been executed — the pipeline (freeze / ledger / resume / rate-limit watchdog) is verified end-to-end and ready to scale. Formal five-metric report: `docs/REPORT.md`. See `docs/DESIGN.md` for the full design and honest deviations list.

## 五种机制

| 机制 | 上游原理 | Zcode 实现 |
|---|---|---|
| **动作融合** Action Fusion | edit/write 可带 `then_run{command,timeout?}`，变异+验证一次调用完成 | MCP 工具 `sol_write` / `sol_edit`（变异语义与内置等价，含 sha256 双读守卫与每文件串行队列） |
| **观察包** Observation Pack | 大型工具结果内容寻址存储，替换为稳定 `obs_<24hex>` 标识符，可精确分页检索 | `sol_bash` 大输出 >10KiB 即归档+占位（头尾 512B 整行摘录），`obs_recall` 字节级分页/搜索召回 |
| **证据保留型约简器** Evidence-Preserving Reducer | 冗长诊断日志仅在每条引用与归档原文**逐字一致**且哈希相符时才简化，否则原文不动 | 诊断命令 ≥4KiB → 归档 → headless zcode 子进程归约（隔离 HOME+工具封禁+aux 防重入三层防护）→ 逐字核验（quote 必须逐字节存在于归档）→ 回执替换；任何失败=原文原样返回（fail-open） |
| **在线上下文压缩** Online Context Compact | 新完成计划步骤成为经济性优化与压力检测候选；优化成功后任务推进并收到提醒 | TodoWrite 边界检测 + 上游经济学公式（1:1 vendor）+ 累积估算器压力检测 + Stop-block 提醒（自限 ≤2/会话 ≤3） |
| **轨迹检查器** Trajectory Inspector | 仅元数据 JSONL：操作/请求/工具使用/结果/压缩信息；不含提示/参数/输出 | 全部 7 个 hook 事件 → hash 链账本（每行 prevHash→hash）；`sol_trajectory` 工具查询；`verify-evidence` CLI 对账任何篡改 |

## 硬约束（全部满足并经审核验证）

- **仅公共插件 API**：MCP server（自定义工具）+ hooks（7 事件）+ manifest；零 npm 运行时依赖（仅 `node:*`）；不 patch 宿主。
- **显式 opt-in**：五机制开关默认全 false（`plugins.options`，见下）；未配置 = hooks 零行为、MCP 工具面为空（e2e 实测零文件零工具）。
- **证据保留**：原文先归档后替换（内容寻址、`O_EXCL`、0600）；账本 append-only + hash 链；`scripts/verify-evidence.mjs` 揭露任何行内改写/中段删插；回执附 `source_artifact` 路径与 readback 指引。
- **宿主管辖权**：身份验证、provider URL、模型选择、shell 行为全部由 Zcode 自身配置决定（归约子进程继承宿主配置，插件不持有任何凭据）。

## 安装与配置（完整指南）

### 一、安装（三选一）

**方式 A：ZCode 客户端 UI（推荐普通用户）**
1. 打开 ZCode → 「发现」（Discover）标签页 → 点 **+**；
2. 选择「本地目录」，填本仓库的本地路径（如 `/Volumes/ti600/SoL-Zcode`，或 clone 后的任意路径）——仓库根目录自带 `marketplace.json` 会被识别为本地市场；
3. 在列表中找到 **sol-zcode** → 点「获取」安装 → 用开关启用；
4. 重启会话（插件配置在会话启动时快照，改完必须新开会话）。

**方式 B：脚本安装（开发/基准/自动化）**
```bash
# 仅安装（全关）
node scripts/install-plugin.mjs plugin sol-zcode-dev

# 安装并全开五机制
node scripts/install-plugin.mjs plugin sol-zcode-dev --options '{"actionFusion":true,"observationPack":true,"evidenceReducer":true,"onlineCompact":true,"trajectory":true}'

# 装到隔离 HOME（不污染本机环境，测试用）
node scripts/install-plugin.mjs plugin sol-zcode-dev --home /tmp/some-home --options '{}'
```
`--options` 为**替换语义**（传 `{}` 即全关；缺省不动现有配置）。

**方式 C：从 GitHub 获取**：clone 本仓库后同方式 A/B。

### 二、开启机制（配置界面在哪）

所有机制**默认关闭**。开启方式三选一（效果等价，写入同一处）：

**路径 1：客户端 UI**
设置 → 插件管理 → **sol-zcode** → 拉到**页面最底部**的「高级配置」（默认折叠，点开）→ 勾选你要的机制（配置项已中文化，含每项行为说明）→ 保存 → **重启会话**。

**路径 2：直接改配置文件** `~/.zcode/cli/config.json`
```json
"plugins": {
  "enabledPlugins": { "sol-zcode@<marketplace>": true },
  "options": {
    "sol-zcode@<marketplace>": {
      "actionFusion": true,
      "observationPack": true,
      "evidenceReducer": true,
      "onlineCompact": true,
      "trajectory": true
    }
  }
}
```
⚠️ 此文件还含你的模型/provider 配置，只改 `plugins` 段，别动其他键。改完**重启会话**。

**路径 3：脚本**（见方式 B 的 `--options`）

### 三、开关速查

| 键 | 类型/默认 | 说明 |
|---|---|---|
| `actionFusion` | bool / `false` | sol_write/sol_edit 支持 then_run：改文件+跑验证一次调用完成，省一半轮次 |
| `observationPack` | bool / `false` | >10KiB 输出改占位符（含头尾摘录+obs_ 编号），obs_recall 分页取回；原文永久归档 |
| `evidenceReducer` | bool / `false` | 冗长失败日志压缩为逐字核验过的证据回执（每次触发额外调一次归约模型，+30~90 秒） |
| `onlineCompact` | bool / `false` | 计划边界+上下文经济学，划算时机提醒收敛（自限 ≤3 次/会话） |
| `trajectory` | bool / `false` | 仅元数据轨迹账本（hash 链防篡改，永不记录提示/参数/输出） |
| `actionFusionGate` | bool / `false` | 硬门：物理拦截原生 Write/Edit 逼模型用 sol_*（激进选项；探针实测 N=1：1 次拦截后 72s 切换、此后 100% 走 sol_*、零反复，代价 ≈1.2 分钟。MCP 未启动时会导致无法写文件，普通使用保持关闭） |
| `reducerModel` | string / `""` | 约简器模型 id（`provider/model`）；空 = 继承主模型（推荐，凭据/模型仍由 ZCode 统一管理） |

类型非法的键按 false 处理并记一条 `config_rejected` 轨迹（可诊断 opt-in 拼写错误）。

### 四、开启后你会看到什么 / 数据在哪

- 模型会收到一段引导（优先使用 sol_* 工具）；工具列表出现 `sol_write / sol_edit / sol_bash / obs_recall / sol_trajectory`；
- 插件数据落盘在 `~/.zcode/cli/plugins/data/sol-zcode@<marketplace>/store/`（观察包对象、证据归档、账本、轨迹，全部 0600 权限、追加式+哈希链）；
- 验证证据完整性：`node plugin/scripts/verify-evidence.mjs`（对账哈希链与归档对象，任何篡改/缺失会逐行报出）；

## 测试

```bash
node scripts/run-tests.mjs          # 138 unit + integration（零模型调用）
node tests/e2e/run-e2e.mjs          # 9 个真模型 e2e 场景（GLM-5.3-Flash，含对抗注入/等价性/fail-open）
node plugin/scripts/verify-evidence.mjs   # 证据完整性对账
```

e2e 亮点：双臂编辑等价（字节级）、观察包分页取回逐字节还原、对抗注入（`rm -rf`/Cron 指令进入归约日志但零副作用）、OCC 真实 1M 窗口经济触发、全关零行为、归档故障 fail-open。

## 与上游的已知偏差（诚实清单）

无历史投影 API → 观察包"首次即占位"（非前 2 次全量）；原生工具大输出不可改写（宿主限制）→ 仅归档+账本；OCC 不能主动触发压缩 → 建议+提醒模式 + 宿主原生 autoCompact 兜底，压缩事后检测在 0.16.5 不可用（G21）；归约走 headless 子进程 → 墙钟代价（LRU 缓解）。完整列表见 `docs/DESIGN.md` §8。

## 仓库结构

```
plugin/            sol-zcode 插件（.zcode-plugin/manifest、mcp/、hooks/、core/ 零依赖 vendor、scripts/verify-evidence）
tests/             unit + integration（138）+ e2e（真模型 9 场景）
scripts/           install-plugin.mjs / run-tests.mjs
benchmark/         Terminal-Bench 4 三臂基准（Harbor 自定义 agent；探针完成，全量待跑）
docs/              DESIGN / PLAN / GOTCHAS(G1-G23 宿主行为坑律) / RESEARCH / REPORT(正式五指标报告) / WORKLOG 审核报告
```

## 质量流程

每个阶段：开发（subagent）→ 独立审核（subagent，带 file:line 证据与 10 分制评分）→ 整改 → 复审，**≥9.5/10 才放行**。审核报告全部落盘 `docs/WORKLOG/AUDIT_*/`：方案 6.5→9.5、P1 9.0→9.5、P2 9.0→9.5、P3 8.5→9.5（三臂数据经逐数字独立复算）。

## 基准结果（TB4 三臂探针，正式报告见 docs/REPORT.md）

Terminal-Bench 4 `html-js-filter` × 三臂（control=五机制全关 / treatment=全开软引导 / gate=全开+硬门，唯一实质差异=`plugins.options`），GLM-5.3-Flash，Harbor 0.23.0。**N=1，plumbing 验证级**——支持"机制管线在真实 TB 任务端到端工作"，不支持统计显著性。

| 指标 | A control | B treatment | C gate |
|---|---|---|---|
| inputTokens | 8,805,055 | 5,980,884（−32.1%） | 3,505,890（−60.2%） |
| API 折算 USD | $0.3464 | $0.2722（−21.4%） | $0.1890（−45.4%） |
| 墙钟 | 53.1 min | 61.1 min（含节流噪声） | 59.6 min（含节流噪声） |
| 请求数 / 异常 / reward | 77 / 无 / 1.0 | 50 / 无 / 0.0 | 30 / 无 / 1.0 |

实测要点（与机制表述有出入处，以实测为准）：

- **节省主通道是请求数坍缩（77→50→30）**，不是单请求变小（每请求 input 三臂恒定 114–120k）；归因 actionFusion 轮次收敛。
- **软引导遵从方差极大**：同一 treatment 配置两极——0 次 sol_* 调用（run2）vs 21 次（存档 B）；bash 通道遵从仅 3/27。**gate 把变更通道方差消成常数**：1 次拦截 → 72 s 切换 → 100% 遵从，代价 ≈1.2 min。
- B 臂未解系方案抽签（BeautifulSoup 重序列化被严格 verifier 拒；A/C 同题已解），不归因机制。
- 全量 63×2 未跑：freeze / ledger / 断点续跑 / 限速看门狗已代码化并测试通过，`benchmark/run.py` 随时可扩；预算两档外推见 `benchmark/README.md`。

## 致谢与许可

- 五机制源自 NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi)（MIT）；`plugin/core/` vendor 自 [SoL-OpenCode](https://github.com/ImKK666/SoL-OpenCode) 的零依赖 core（保留 NVIDIA/ImKK666 版权头，见 `plugin/THIRD_PARTY_NOTICES.md`）。
- 本项目 MIT。
