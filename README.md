# dsh-rea-dispatcher

把一个「207 个工具、3.1 MB 工具表」的逆向 MCP 服务，折叠成 **3 个入口、约 1 KB 常驻上下文**。

一个 DeepSeek Harness 插件，包装 [REA](https://github.com/morluto/rea)（以 Ghidra 为后端的逆向 MCP 服务），只在真正调用时按需展开单个工具的 Schema。

## 为什么需要它

REA 的 `tools/list` 原始响应是 **3,158,415 字节 / 207 个工具**。直挂 MCP 时，宿主会把每个工具的定义写进系统提示：

| 方案 | 工具数 | 进入上下文的部分 | 折算 token |
| --- | --- | --- | --- |
| 直挂 REA | 207 | 775,016 B（`{name, description, parameters}`） | 约 19–22 万 |
| 挂本插件 | 3 | 1,044 B | 忽略不计 |

口径：775,016 B 是按 `dsh-mcp-client` 的注册形状、对 REA 6.7.0 真实的 207 份 schema 算出来的；3,158,415 B 是原始线上响应，含 outputSchema/注解等不会进上下文的字段（`test/ab-surface.mjs` 可复算）。

直挂等于在模型读到第一个字之前吃掉大半个上下文窗口；不挂则 207 个工具一个都用不上。这个插件解决的就是这个两难。

## 它怎么做到的

不给模型全部定义，分三步，每次只给当前需要的那一片。

| 步 | 工具 | 作用 | 返回 |
| --- | --- | --- | --- |
| ① | `rea_tools` | 列目录 | 工具名 + 标题，可按关键词筛 |
| ② | `rea_help` | 看详情 | 这一个工具的必填项、已知陷阱、参数 Schema |
| ③ | `rea_call` | 执行 | 参数原样透传给 REA |

模型永远只看到 3 个入口；`rea_help` 一次只展开一个；`rea_call` 不加载任何额外定义。没有索引服务，没有额外依赖。

## 装完怎么用

**先装 REA 本体**（插件不代装引擎）：

```bash
npm i -g rea-agents
```

**再装插件**（bundle 自己插进 profile，无需手改 patch）：

```bash
dsh plugin --profile <你的profile> add github:HarunaTyan/dsh-rea-dispatcher
```

装完在市场里点启用，或让 AI 用宿主工具 `plugin_manager set_bundle dsh-rea-dispatcher enabled=true`；不用重启。`--profile <p> --dump-config` 里出现 `- id: rea-dispatcher` 即生效。

**人这边**：不需要配置任何东西。默认 `cwdAllow: []`（不限制），引擎路径从 `GHIDRA_INSTALL_DIR` / `JAVA_HOME` 环境变量读。

**AI 那边**：什么都不用读。3 个工具的描述里已写明三步流程；第一次拉工具目录时，`rea_tools` 会在结果开头附两行用法与「默认不限制目录」的说明。你只要说一句：

> 用 REA 分析 `<路径>`：先 rea_tools 找工具，rea_help 看参数，再 rea_call；不要猜工具名。

## 三步调用长什么样

```text
rea_tools filter=image
rea_help  name=inspect_native_load_image
rea_call  name=inspect_native_load_image arguments={"path":"C:/target/app.exe"}
```

`rea_help` 的头几行是你最需要的——必填项和已知陷阱，不用在长描述里翻：

```text
# procedure_pseudo_code
标题：Procedure Pseudo Code
必填：procedure
⚠️ `0x…` 若不是函数入口会退化成 file offset；先 procedure_info 拿入口再调用
```

`rea_call` 对 REA 的错误原样透传，只在前面加一行标注，说明错误来自 REA 而不是调度层。

## 配置（全部可选）

默认值从环境派生，包里没有硬编码的机器路径。要覆盖就写进 profile 的 `cordis.patch.yml`，按 entry id `rea-dispatcher`：

```yaml
- id: rea-dispatcher
  config:
    cwdAllow: ['D:/re-projects']
    ghidraDir: "D:/tools/ghidra_12.1.4_PUBLIC"
    javaHome: "D:/tools/JDK21"
    callTimeoutMs: 600000
    maxBytes: 40000
```

⚠️ patch 里的 `config` 是**整体替换**，不是深合并：写了这个块就要把用到的键一次写全，否则未写的键回退默认值。这是 DSH patch 的行为。

| 键 | 作用 | 默认 |
| --- | --- | --- |
| `ghidraDir` | 注入 `GHIDRA_INSTALL_DIR` | 同名环境变量 |
| `javaHome` | 注入 `JAVA_HOME`，并把其 `bin` 前置进 PATH（要 JDK 21，17 不够） | 同名环境变量 |
| `reaMjs` | REA 的 `scripts/rea.mjs` 绝对路径 | 自动探测（`REA_MJS` → 已装 `rea-agents` → npm 全局） |
| `childCwd` | REA 子进程工作目录 | 系统临时目录 |
| `cachePath` | 工具表缓存 | `<DSH_HOME>/rea-dispatcher-cache.json` |
| `spillDir` | 超限结果全文落盘目录 | `<DSH_HOME>/rea-spill` |
| `cwdAllow` | 会话目录白名单 | `[]`（不限制，见下） |
| `callTimeoutMs` / `listTimeoutMs` | 单次调用 / 握手超时 | 300000 / 120000 ms |
| `maxBytes` | `rea_call` 返回上限（`0`/负 = 按默认值，不是「不限」） | 20000 |
| `spill` / `spillKeep` | 超限落盘 / 保留份数 | `true` / 50 |
| `helpMaxChars` | `rea_help` 返回上限 | 12000 |

引擎缺失不会让插件挂掉：`rea_tools` 照样列目录，只有调用到需要引擎的工具才回 REA 自己的错误。缺 `rea-agents` 本体则会直接给一句可照抄的安装提示。

工具表按已装 `rea-agents` 的版本号缓存，升级 REA 自动失效；读不到版本号（自定义 `reaMjs` 不在包内）时不读也不写缓存，每次重新拉一次（约 3 MB / 2–3 s）。

## 结果太长会不会丢

不会。超过 `maxBytes` 时正文截断，**全文落盘**，尾部给出路径：

```text
[全文已落盘：C:\Users\you\.dsh\rea-spill\list_procedures-2026-10-29T18-57-38.txt
（209,174 字符 / 8,412 行）。用 ops_read_files 或 ops_grep 分段读，不必再调一次 rea_call]
```

只读需要的行区间，不要整份读回来 —— 否则等于把上下文问题换个地方发生。

REA 本身不截断（`list_procedures` 一次就是 209K），宿主 DSH 也没有统一的工具返回上限；截断与落盘都是本插件的策略。

## 安全边界：cwdAllow

- **空数组（默认）**：不限制，任何目录下的会话都能调用。
- **非空**：按路径段比较，`/re/proj2` 不会被 `/re/proj` 放行；比较前折叠 `.` 和 `..`；Windows 忽略大小写；`['/']` 放行整个文件系统；取不到会话目录时**拒绝**而不是猜。
- ⚠️ 它只约束**会话目录**，不约束 `rea_call` 的 `arguments` 里的路径：`open_binary` 仍能读任意路径的二进制。要更强隔离，把 REA 子进程跑在受限账户/沙箱里。

## 适用与不适用

**适合**：单点、可验证的查询（伪代码、交叉引用、字符串、导入导出表）；在对话里逐步缩小范围的探索。全量枚举拿得到，但要靠落盘文件分页读。

**不适合**：需要长事务、多轮保持同一二进制状态的深度分析 —— `callTimeoutMs` 一到子进程被丢弃，`open_binary` 的状态要重做；大规模枚举本地 `analyzeHeadless` + 脚本更省。

REA 侧还有几个会让人误判的陷阱（不是本插件的问题）：`open_binary` 成功后 `current_document` 仍可能报 `target_unavailable`（app 级状态与 headless 会话不同步）；`procedure_pseudo_code` 的 `0x…` 若不是函数入口会退化成 file offset；`inspect_pcap_client` 需要 `tshark` 在 PATH。

## 设计取舍

- **不代装 REA**：只管调度，引擎版本你自己定；代价是安装多一步，好处是升级 REA 不绑插件版本。
- **不深合并 config**：跟随 DSH patch 机制，行为可预测；代价是覆盖时要写全。
- **cwdAllow 只做会话级**：不在 `arguments` 上做路径拦截，因为需要理解每个工具的路径语义，容易误伤；强隔离交给沙箱。
- **超时即丢子进程**：逆向会话状态复杂，强行复用的不确定性比重新握手更麻烦。

## 排错

| 现象 | 处理 |
| --- | --- |
| `未找到 rea-agents 的 MCP 入口` | `npm i -g rea-agents`，或设 `reaMjs` / `REA_MJS` |
| `当前目录未授权` | 会话 cwd 不在 `cwdAllow` 里；改配置或在允许的目录开会话 |
| REA 报 Java 版本不足 | `javaHome` / `JAVA_HOME` 指向 JDK 21（PATH 上的 17 不够） |
| `target_format_unsupported` | Windows 上 Ghidra provider 只吃 native PE 与 raw 6502；ELF 能 `open_binary` 但深分析不行 |
| `current_document` 报 "No app is open" | REA 侧 app 级状态与 headless 会话不同步，不是目标没打开 |
| `inspect_pcap_client` 报 `capability_unavailable` | 需要 `tshark` 在 PATH |

## 开发

测试只能在仓库里跑（npm 包不含 `test/`）：

```bash
git clone https://github.com/HarunaTyan/dsh-rea-dispatcher && cd dsh-rea-dispatcher
node test/resolver.mjs     # 路径派生、白名单、渲染与截断、落盘（无需 REA）
node test/smoke.mjs        # 真跑 REA：207 工具、三步链路、截断落盘（需已装 rea-agents）
node test/ab-surface.mjs   # 复算上面那张体积对照表
```

## 许可

MIT
