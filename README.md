# dsh-rea-dispatcher

DeepSeek Harness 插件。把 [REA](https://github.com/morluto/rea)（逆向 MCP 服务，npm 包 `rea-agents`，后端 [Ghidra](https://ghidra-sre.org/)、[Hopper](https://www.hopperapp.com/)、[IDA](https://hex-rays.com/ida-pro/)）的 207 个工具折叠成 3 条命令，另有 6 个只读域入口。常驻约 5 KB，直挂约 757 KB。

## 体积

| 接入方式 | 工具数 | 进入上下文 | 折算 token |
| --- | --- | --- | --- |
| 直接挂载 REA | 207 | 775,016 B | 约 19 万至 22 万 |
| 本插件（默认） | 9 | 3,404 字符 / 5,322 B | 约 1.3 K |
| 本插件（`domainTools: false`） | 3 | 1,481 字符 / 2,213 B | 可忽略 |

> 数字按 `{name, description, parameters}` 序列化后计算，字符数与 UTF-8 字节数分开给。
> 离线复算：`node test/ab-surface.mjs`（用 `test/fixtures/` 里的目录快照，不需要装 REA）；B 侧数字是宿主编译产物，装了宿主包才会打印。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rea_tools` | 列工具名与标题，按域分组，支持 `filter` |
| `rea_help` | 单个工具的必填项、已知陷阱、参数 schema |
| `rea_call` | 调用工具，参数原样透传 |
| `rea_native` `rea_web` `rea_apk` `rea_mobile` `rea_firmware` `rea_general` | 只读域清单，只列本域工具 |

域入口只列名字，不执行。执行一律走 `rea_call`。

## 安装

先自备依赖，插件不代装引擎。

| 依赖 | 用途 |
| --- | --- |
| DSH | 宿主 |
| Node.js 22 或 24 | 运行 REA 的 MCP 入口 |
| rea-agents | 提供 207 个逆向工具 |
| Ghidra 12.1.x 与 JDK 21 | 供需要引擎的工具使用 |

```bash
npm i -g rea-agents
dsh plugin --profile <profile> add github:HarunaTyan/dsh-rea-dispatcher
```

装好后在市场启用，或由 AI 侧调用 `plugin_manager set_bundle dsh-rea-dispatcher enabled=true`，无需重启。`dsh --profile <profile> --dump-config` 里出现 `- id: rea-dispatcher` 即生效。

> 引擎路径默认读 `GHIDRA_INSTALL_DIR` 与 `JAVA_HOME`。没配也能加载并列目录，只有用到引擎的工具会报 REA 自己的错。缺 `rea-agents` 时返回可直接执行的安装提示。

> 宿主版本区间 `>=0.2.1-rc.1 <0.3.0-0`；`0.2.2-rc.x` 这类后续预发布不在区间内，需要时发版扩区间。

## 使用

这些工具由会话里的 AI 调用，不需要手敲。

```text
rea_tools filter=image
rea_native filter=procedure
rea_help name=inspect_native_load_image
rea_call name=inspect_native_load_image arguments={"path":"C:/target/app.exe"}
```

`rea_help` 开头就是必填项与高代价陷阱：

```text
# procedure_pseudo_code
必填：procedure
⚠️ `0x…` 若不是函数入口会退化成 file offset；先 procedure_info 拿入口再调用
```

REA 的错误原样返回，只在首行标注来源。REA 会话不跨轮：上一轮 `open_binary` 成功，下一轮仍可能报 `No app is open`。插件默认自动重开并重试一次，输出里会标注；`autoReopen: false` 关掉。

> 返回超过 `maxBytes` 时截断，全文落盘并在尾部给出路径与行数，可用 `ops_read_files` 或 `ops_grep` 分段读。

## 配置

默认值都由环境派生，包内不含机器路径。覆盖写在 profile 的 `cordis.patch.yml`，entry id 是 `rea-dispatcher`。

```yaml
- id: rea-dispatcher
  config:
    cwdAllow: ['D:/re-projects']
    ghidraDir: "D:/tools/ghidra_12.1.4_PUBLIC"
    javaHome: "D:/tools/JDK21"
    callTimeoutMs: 600000
    maxBytes: 40000
```

> patch 里的 `config` 是整体替换，不是深合并；覆盖时要把用到的键一次写全。

| 键 | 作用 | 默认 |
| --- | --- | --- |
| `reaMjs` | `scripts/rea.mjs` 路径 | 自动探测 |
| `ghidraDir` | 注入 `GHIDRA_INSTALL_DIR` | 同名环境变量 |
| `javaHome` | 注入 `JAVA_HOME`，并把其 `bin` 前置到 PATH | 同名环境变量 |
| `cwdAllow` | 会话目录白名单 | `[]`，不限制 |
| `maxBytes` | 单次返回上限 | 20000 |
| `autoReopen` | 掉线自动重开一次 | `true` |
| `spill` | 超限时落盘全文 | `true` |
| `domainTools` | 是否注册 6 个域入口 | `true` |
| `domainLimit` | 域清单条数上限 | 40 |
| `helpMaxChars` | `rea_help` 返回上限 | 12000 |
| `callTimeoutMs` | 单次调用超时 | 300000 |
| `listTimeoutMs` | 握手与列目录超时 | 120000 |

## 边界

**`cwdAllow` 只约束会话目录**

- 空数组不限制。非空时按路径段比较，`/re/proj2` 不会被 `/re/proj` 放行，比较前折叠 `.` 与 `..`，Windows 忽略大小写。
- 取不到会话目录时拒绝。
- 它不约束 `rea_call` 参数里的路径。要更硬的隔离，把 REA 子进程放进受限账户或沙箱。

**适合与不适合**

- 适合单点可验证的查询（伪代码、交叉引用、字符串、导入导出表）与逐步缩小范围的探索。
- 不适合长时间维持同一二进制状态的深挖，超时会丢子进程；也不适合全量枚举。

## REA 侧限制

- **Windows 上只吃 native PE 与 raw 6502**。ELF 能 `open_binary`，深分析会被四个 provider 全拒，报 `target_format_unsupported`；打开成功不等于可分析。
- **不带符号**。同目录 PDB 不会被导入，函数仍显示为 `FUN_1400xxxxx`，要符号得本地跑 `analyzeHeadless`。

## 排错

| 现象 | 处理 |
| --- | --- |
| `未找到 rea-agents 的 MCP 入口` | `npm i -g rea-agents`，或配 `reaMjs` / `REA_MJS` |
| `当前目录未授权` | 会话目录不在 `cwdAllow` 里，调整配置或在允许目录开会话 |
| `target_format_unsupported` | 目标格式不支持，见上面 REA 侧限制 |
| `capability_unavailable` | 缺外部工具，例如 `tshark` |

## 开发与反馈

测试脚本在仓库里，npm 包不含 `test/`。

```bash
git clone https://github.com/HarunaTyan/dsh-rea-dispatcher && cd dsh-rea-dispatcher
node test/resolver.mjs
node test/smoke.mjs
node test/ab-surface.mjs
node test/start-failure.mjs
```

问题提到 [Issues](https://github.com/HarunaTyan/dsh-rea-dispatcher/issues)，附 DSH 版本、`rea-agents` 版本与报错原文。个人维护，按优先级尽力修复。

## 许可

MIT。与 REA、Ghidra、DSH 等项目无隶属关系。
