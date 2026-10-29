# dsh-rea-dispatcher

DeepSeek Harness 插件，将 [REA](https://github.com/morluto/rea)（以 [Ghidra](https://ghidra-sre.org/) 为后端的逆向 MCP 服务，npm 包名 `rea-agents`）的 207 个工具折叠为 3 个按需入口，常驻上下文约 1 KB。

## 它做什么

REA 的 `tools/list` 原始响应为 3,158,415 字节，共 207 个工具。直接挂载时，宿主会把每个工具的定义写入系统提示：

| 接入方式 | 工具数 | 进入上下文的体积 | 折算 token |
| --- | --- | --- | --- |
| 直接挂载 REA | 207 | 775,016 B（`{name, description, parameters}`） | 约 19–22 万 |
| 本插件 | 3 | 1,044 B | 可忽略 |

775,016 B 按 `dsh-mcp-client` 的注册形状对 REA 6.7.0 的 207 份 schema 计算；3,158,415 B 为线上原始响应，含 outputSchema、注解等不进入上下文的字段。复算脚本见 `test/ab-surface.mjs`。

为此插件只暴露三个入口，按需展开：

| 工具 | 作用 | 返回 |
| --- | --- | --- |
| `rea_tools` | 列出工具名与标题，支持关键词筛选 | 目录 |
| `rea_help` | 单个工具的必填项、已知陷阱、参数 Schema | 该工具的说明 |
| `rea_call` | 调用工具，参数原样透传 | REA 的原始结果 |

## 安装

前置条件：[DSH](https://github.com/deepseek-ai/deepseek-harness)；[Node.js](https://nodejs.org/)；[REA](https://github.com/morluto/rea) 本体（[npm `rea-agents`](https://www.npmjs.com/package/rea-agents)，插件不代装引擎）；[Ghidra](https://ghidra-sre.org/) 12.1.x 与 [JDK 21](https://adoptium.net/)（供需要引擎的工具使用）。

```bash
npm i -g rea-agents
dsh plugin --profile <profile> add github:HarunaTyan/dsh-rea-dispatcher
```

安装后在市场启用，或由 AI 侧调用宿主工具 `plugin_manager set_bundle dsh-rea-dispatcher enabled=true`，无需重启。`dsh --profile <profile> --dump-config` 中出现 `- id: rea-dispatcher` 即生效。

引擎路径默认读取 `GHIDRA_INSTALL_DIR` 与 `JAVA_HOME`。未配置时插件仍可加载并列出工具目录，仅调用到需要引擎的工具时报 REA 自身的错误；缺少 `rea-agents` 时返回可直接执行的安装提示。

## 使用

```text
rea_tools filter=image
rea_help  name=inspect_native_load_image
rea_call  name=inspect_native_load_image arguments={"path":"C:/target/app.exe"}
```

`rea_help` 首部即给出必填项与高代价陷阱，无需通读说明：

```text
# procedure_pseudo_code
标题：Procedure Pseudo Code
必填：procedure
⚠️ `0x…` 若不是函数入口会退化成 file offset；先 procedure_info 拿入口再调用
```

`rea_call` 对 REA 的错误原样返回，仅在首行标注来源为 REA 而非调度层。返回超过 `maxBytes` 时正文截断、全文落盘，尾部给出文件路径与行数，可用 `ops_read_files` / `ops_grep` 分段读取。REA 与宿主 DSH 均不限制返回体积，截断与落盘是本插件的策略。

## 配置

全部可选，默认值由环境派生，包内不含机器路径。覆盖写在 profile 的 `cordis.patch.yml`，按 entry id `rea-dispatcher`：

```yaml
- id: rea-dispatcher
  config:
    cwdAllow: ['D:/re-projects']
    ghidraDir: "D:/tools/ghidra_12.1.4_PUBLIC"
    javaHome: "D:/tools/JDK21"
    callTimeoutMs: 600000
    maxBytes: 40000
```

patch 中的 `config` 为整体替换而非深合并，覆盖时需一次写全所用键。

| 键 | 作用 | 默认 |
| --- | --- | --- |
| `reaMjs` | `scripts/rea.mjs` 绝对路径 | 自动探测：`REA_MJS` → 已装 `rea-agents` → npm 全局 |
| `ghidraDir` | 注入 `GHIDRA_INSTALL_DIR` | 同名环境变量 |
| `javaHome` | 注入 `JAVA_HOME`，并将其 `bin` 前置到 PATH | 同名环境变量，须 JDK 21 |
| `childCwd` | REA 子进程工作目录 | 系统临时目录 |
| `cachePath` | 工具表缓存 | `<DSH_HOME>/rea-dispatcher-cache.json` |
| `cwdAllow` | 会话目录白名单 | `[]`，不限制 |
| `callTimeoutMs` | 单次 `rea_call` 超时 | 300000 ms |
| `listTimeoutMs` | 握手与 `tools/list` 超时 | 120000 ms |
| `maxBytes` | `rea_call` 返回上限；`0` 或负值按默认处理 | 20000 |
| `spill` | 超限时是否落盘全文 | `true` |
| `spillDir` | 落盘目录 | `<DSH_HOME>/rea-spill` |
| `spillKeep` | 落盘文件保留数量，超出按修改时间删除 | 50 |
| `helpMaxChars` | `rea_help` 返回上限 | 12000 |

超时后子进程被丢弃，下次调用重新握手，已加载的二进制需重新 `open_binary`。工具表按已装 `rea-agents` 版本缓存；无法读取版本号时不读也不写缓存，每次重新拉取（约 3 MB，2–3 秒）。

## 边界

`cwdAllow`：

- 空数组（默认）不限制。
- 非空时按路径段比较（`/re/proj2` 不会被 `/re/proj` 放行），比较前折叠 `.` 与 `..`；Windows 忽略大小写；`['/']` 表示整个文件系统；无法取得会话目录时拒绝。
- 仅约束会话目录，不约束 `rea_call` 的 `arguments` 中的路径。需要更强隔离时，应将 REA 子进程运行在受限账户或沙箱内。

适用性：

- 适合单点、可验证的查询（伪代码、交叉引用、字符串、导入导出表）与逐步缩小范围的探索。
- 不适合需要多轮维持同一二进制状态的深度分析（超时会丢弃子进程），也不适合大规模枚举（本地 `analyzeHeadless` 加脚本开销更低）。

REA 侧限制（非本插件行为）：

- Windows 上 Ghidra provider 仅接受 native PE 与显式 raw 6502；ELF 可 `open_binary`，深分析返回 `target_format_unsupported`。
- `open_binary` 成功后，`current_document` 仍可能返回 `target_unavailable`，因 app 级状态与 headless 会话不同步。
- `procedure_pseudo_code` 的 `0x…` 不是函数入口时会退化为 file offset。
- `inspect_pcap_client` 需要 `tshark` 在 PATH。

## 排错

| 现象 | 处理 |
| --- | --- |
| `未找到 rea-agents 的 MCP 入口` | 执行 `npm i -g rea-agents`，或配置 `reaMjs` / `REA_MJS` |
| `当前目录未授权` | 会话目录不在 `cwdAllow` 内；调整配置或在允许的目录开会话 |
| REA 报 Java 版本不足 | `javaHome` / `JAVA_HOME` 指向 JDK 21 |
| `target_format_unsupported` | 目标格式不受支持，见上节 |
| `capability_unavailable` | 缺少外部工具（如 `tshark`） |

## 开发与反馈

测试脚本位于仓库，npm 包不含 `test/`：

```bash
git clone https://github.com/HarunaTyan/dsh-rea-dispatcher && cd dsh-rea-dispatcher
node test/resolver.mjs     # 路径派生、白名单、渲染与截断、落盘
node test/smoke.mjs        # 需已装 rea-agents：工具目录、三步链路、截断落盘
node test/ab-surface.mjs   # 复算体积对照表
```

问题请提交至 [GitHub Issues](https://github.com/HarunaTyan/dsh-rea-dispatcher/issues)，附 DSH 版本、`rea-agents` 版本、`rea doctor --json` 输出与报错原文。个人维护项目，按优先级尽力修复，不承诺响应时限。

## 许可

MIT。本插件与 REA、Ghidra、DSH 等项目无隶属关系，文中链接仅指向各项目的官方仓库或站点。
