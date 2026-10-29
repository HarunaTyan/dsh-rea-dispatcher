# dsh-rea-dispatcher

把 [REA](https://github.com/morluto/rea)（rea-agents，Ghidra 反汇编后端）的 200+ 个 MCP 工具**分三段按需**暴露给 DeepSeek Harness：

```
rea_tools  → 工具名与标题（目录）
rea_help   → 单个工具的说明 + 参数 schema
rea_call   → 实际调用，参数原样透传
```

不把整份工具表塞进每次请求。

## 为什么需要它

REA 的 `tools/list` 是 **3,158,415 字节**（207 个工具）。直接挂 MCP 服务器，每个工具的定义都会进系统提示：

| 接入方式 | 每次请求的工具表体积 |
| --- | --- |
| 直接挂 REA MCP（207 工具） | 775,016 B ≈ 19–22 万 token |
| 本插件（3 个工具） | 1,044 B |

平均每个工具 3,744 B，最大的 `compare_web_captures` 单个就 166,651 B（同机实测，脚本见 `test/ab-surface.mjs`）。也就是说，直接挂载会在模型看到第一个字之前花掉整个上下文窗口。

本插件只在需要时取单个工具的 schema，`tools/list` 结果带版本号缓存在 `<DSH_HOME>/rea-dispatcher-cache.json`，升级 REA 后自动失效。

## 安装

```bash
# 1) 先装 REA 本体（本插件不代装引擎）
npm i -g rea-agents

# 2) 装本插件（bundle 会自己插进 profile，无需构建授权）
dsh plugin --profile <profile> add github:HarunaTyan/dsh-rea-dispatcher
```

装完用宿主的 `plugin_manager set_bundle dsh-rea-dispatcher enabled=true` 挂载即可（无需重启）。

实测（空 profile）：上面第二条命令装出 `+ dsh-rea-dispatcher 1.0.0`，`--dump-config` 里直接出现
`- id: rea-dispatcher` 一行，不需要手写 patch。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| `rea-agents` | 提供 `scripts/rea.mjs`（MCP 入口）。默认从全局 npm 目录探测，也可用 `reaMjs` / `REA_MJS` 指定绝对路径。 |
| Ghidra 12.1.x | REA 的 Ghidra provider 要求；目录通过 `GHIDRA_INSTALL_DIR` 或 `config.ghidraDir` 给出。 |
| JDK 21 | 通过 `JAVA_HOME` 或 `config.javaHome` 给出 —— 插件只把它注入子进程，不会改系统环境变量。 |

三者缺一，插件本身照常加载，`rea_tools` 也能列目录，只有真正调用到需要引擎的工具时才会报 REA 自己的错误。

## 配置

全部可选，默认值都从环境派生，包里不含任何机器路径：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `reaMjs` | `''` | `scripts/rea.mjs` 绝对路径。空 = 探测 `REA_MJS` → 已装 `rea-agents` → npm 全局前缀 |
| `ghidraDir` | `''` | 注入子进程的 `GHIDRA_INSTALL_DIR`。空 = 用同名环境变量 |
| `javaHome` | `''` | 注入 `JAVA_HOME` 并把其 `bin` 前置进 `PATH` |
| `childCwd` | `''` | REA 子进程工作目录。空 = 系统临时目录 |
| `cachePath` | `''` | 工具表缓存。空 = `<DSH_HOME>/rea-dispatcher-cache.json` |
| `cwdAllow` | `[]` | 允许使用 `rea_*` 的会话目录白名单；空数组 = 不限制 |
| `callTimeoutMs` | `300000` | 单次 `rea_call` 超时 |
| `listTimeoutMs` | `120000` | 握手与 `tools/list` 超时 |
| `maxBytes` | `20000` | `rea_call` 返回文本上限（超出截断并标注） |
| `helpMaxChars` | `12000` | `rea_help` 返回上限（个别工具 schema 有 4 万字符） |

按 entry id 覆盖（profile 自己的 `cordis.patch.yml`）：

```yaml
- id: rea-dispatcher
  name: "dsh-rea-dispatcher"
  config:
    cwdAllow: ['D:/re-projects']
    ghidraDir: "D:/tools/ghidra_12.1.4_PUBLIC"
    javaHome: "D:/tools/JDK21"
```

注意 patch 是**整体替换** `config`，不是深合并，所以要用到的键要一次给全。

`cwdAllow` 按路径段比较（`/re/proj2` 不会被 `/re/proj` 放行）。

## 用法

```
rea_tools filter=image            # 找名字
rea_help name=inspect_native_load_image   # 看参数
rea_call name=inspect_native_load_image arguments={"path":"C:/target/app.exe"}
```

`rea_call` 对 REA 的错误原样透传（例如 `target_unavailable`），不改写、不吞。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `未找到 rea-agents 的 MCP 入口` | 没装或不在探测路径内：`npm i -g rea-agents`，或设 `reaMjs` / `REA_MJS` |
| `当前目录未授权` | 会话 cwd 不在 `cwdAllow` 里；改配置或在允许的目录开会话 |
| `target_format_unsupported` | 平台限制，见下 |
| Ghidra 报 Java 版本不足 | `javaHome` / `JAVA_HOME` 指向 JDK 21（系统 PATH 上的 17 不够） |

**已实测的平台边界**：Windows 上 REA 6.7.0 的 Ghidra provider 只接受 **native PE** 与显式 raw 6502。ELF（例如 PS4 `eboot_decrypted.bin`）能 `open_binary`，但深分析一律返回 `target_format_unsupported` —— 这是 REA 的限制，不是本插件的。

## 开发

```bash
node test/resolver.mjs    # 路径派生与渲染逻辑（无需 REA）
node test/smoke.mjs       # 需要本机已装 rea-agents
node test/ab-surface.mjs  # 复算上面那张体积对照表
```

## 问题反馈

用 [GitHub Issues](https://github.com/HarunaTyan/dsh-rea-dispatcher/issues) 提，附上 DSH 版本、`rea-agents` 版本、`rea doctor --json` 的输出和报错原文。个人项目，尽力而为地修。

## 许可

MIT。
