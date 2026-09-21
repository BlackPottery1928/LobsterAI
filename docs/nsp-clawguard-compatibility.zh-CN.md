# nsp-clawguard 启动兼容补丁

## 原因与修复范围

本地 `nsp-clawguard 2.5.0` 可以复现 QA 日志中的网关启动异常。插件单文件
ESM 产物内的 esbuild `__require` 没有绑定原生 `require`：

- 经旧的 OpenClaw 加载路径转换后，内嵌 `graceful-fs` 取得的 `fs` 代理不能正常
  访问 symbol 队列。插件修改共享的 `fs.close/closeSync` 后，网关在关闭文件时
  抛出 `Cannot read properties of undefined (reading 'length')`，连诊断日志写入也失败。
- 修正 Windows file URL 的原生加载路径后，原插件改为在加载时抛出
  `Dynamic require of "util" is not supported`，插件无法注册。
- 只补齐 `require` 后，插件能够注册，但 `gateway_start` 的异步数据库初始化仍会
  在内嵌 SQL.js 中访问缺失的 `__dirname` / `__filename`。未处理的 rejection
  会使刚进入 ready 的网关退出；不能以插件注册成功或首次 ready 作为验收结果。

LobsterAI 在配置同步开始时、调用 OpenClaw 迁移 CLI 之前，检查已启用的用户插件，
将该插件已知的 `__require` helper 替换为 `createRequire(import.meta.url)`，
并由 `fileURLToPath(import.meta.url)` 和 `dirname()` 补齐模块内的 CommonJS 路径。
路径按文件 URL 解码，支持 Windows 盘符、空格和中文。兼容原始包及上一版只补齐
`require` 的 v1 入口；不会跳过插件的 `gateway_start` 回调。
其他依赖代码、插件配置和权限保持原样。
文件改变需要新网关进程，沿用现有的重启、活跃任务延期和自重启等待机制。

补丁只识别包名及 manifest ID 为 `nsp-clawguard`、版本均为 `2.5.0`、入口为
`./dist/index.mjs` 且具有已知 helper 的包。其他版本或结构记录诊断后跳过。
QA 归档没有插件包体及可核对的版本，仍需原机确认版本并回测。

## 用户状态与文件处理

| 状态 | 行为 |
| --- | --- |
| 未安装，或只有其他用户插件 | 直接返回，不访问、创建或下载插件文件，不改变网关重启需求 |
| 已安装但未启用 | 不读取或修改插件文件；不会自动启用 |
| 已安装且启用，版本和结构匹配 | 备份原入口后替换 helper；在网关加载前完成 |
| 已有 v1 native require 补丁 | 备份 v1 入口后升级到 v2 模块上下文，保留原来的备份 |
| 已打补丁，再次启动或同步 | 不重复写入或新增备份，不因补丁再次触发重启 |
| 重新安装或更新覆盖入口 | 下次配置同步重新检查；禁用状态下等到再次启用才处理 |
| 安装记录残留、目录已不存在 | 不重建目录或安装插件 |
| 版本或入口结构不匹配 | 不修改文件；由日志说明跳过原因 |

检查范围仅为本地插件管理记录和两个安装位置：

- `userData/third-party-extensions/nsp-clawguard`
- `stateDir/extensions/nsp-clawguard`

不扫描其他目录，不修改随包 OpenClaw 文件，不跟随插件目录、入口目录或入口文件的
符号链接。仅由外部配置引用、尚未同步到 LobsterAI 插件管理记录的安装不在本次范围内。

原文件备份位于入口旁，格式为
`index.mjs.lobsterai-native-module-v2.<修改前文件 SHA-256>.bak`。
重复遇到同一原文件时验证并复用备份，不覆盖已有备份。写入复用项目的安全文件替换
逻辑，支持 Windows 的 rename 限制和失败恢复。备份或替换失败会记录错误，不继续
强制改写，不修改其他插件。此时本插件的启动问题可能仍然存在。

如需回滚，先在插件管理中禁用插件并退出应用，再用匹配的备份恢复入口；保持禁用，
避免下次启用时再次应用补丁。

## 验证及限制

自动测试覆盖未安装、禁用、启用、两个安装目录、重复执行、重新安装、未知结构、
CRLF、符号链接、备份冲突、写入失败，以及原生 ESM 和模拟 interop 代理下的
插件注册与宿主文件关闭。异步启动回归用例覆盖原始 helper 和 v1 helper，实际执行
回调并校验带中文、空格、`#` 和 `%` 的模块路径及文件读写；还覆盖 v1 备份保留、
重复升级和已有路径变量时的保守跳过。

此前 v1 的 Windows 隔离网关实验使用真实 `2.5.0` 插件副本、临时状态和独立端口，结果如下。
旧加载路径对照通过临时 runtime 副本恢复 file URL 转换修复前的行为实现，
没有修改开发目录的 runtime。

| 场景 | 插件注册 | 网关启动 |
| --- | --- | --- |
| 未安装 | 不加载 | ready |
| 已安装但禁用 | 不加载 | ready |
| 原插件，旧加载路径 | 注册后污染宿主 fs | `.length` 异常，退出 1 |
| 打补丁，旧加载路径 | 成功 | ready |
| 原插件，当前原生加载路径 | `Dynamic require` 失败 | ready，但插件未加载 |
| 打补丁，当前原生加载路径 | 成功 | ready |

上述历史实验屏蔽了插件的 `gateway_start` 回调，未覆盖异步数据库初始化，
因此没有发现 ready 后退出的问题，不能证明完整启动成功。

2026-09-21 的 v2 验收使用 Electron 43.5.0（Node 24.19.0）客户端、隔离的
用户目录和 npm 发布的 `nsp-clawguard@2.5.0`，通过调试端口和 Playwright/CDP
操作页面，不接管系统键鼠。原始 `dist/index.mjs` 的 SHA-256 为
`5b82694031dfeb06964a00ecb218bec4f2e8ff250f2c23cb0a1057614b90eb25`。
插件保持真实的 `gateway_start`、SQL.js 和后台初始化；配置为 offline，远端
请求由本地拒绝代理返回 503，未屏蔽启动回调。

本机 Windows 的既有加载路径会回退到 Jiti 转译，v1 在该路径下不复现缺失路径变量。
为覆盖日志中的原生 ESM 故障，额外以测试进程预加载脚本，仅将隔离目录内的 NSP
入口改由 Node 原生 ESM 加载，其他插件和 runtime 文件不修改。该对照中，v1
先 ready，随后 `gateway_start` 抛出 `ReferenceError: __dirname is not defined`，
网关退出 1 并重试；v2 自动升级同一份 v1 安装，完成 `lm-security.db` 初始化，
ready 后持续运行超过 90 秒，进程 PID 不变且没有异常退出。

同一客户端内，通过设置页切换插件开关并点击保存，完成禁用和重新启用；随后经
Electron preload 的 `restartGateway()` 接口主动重启。三次操作均恢复 running，
旧进程正常退出 0，启用时真实启动回调和数据库初始化成功。入口 SHA-256、修改时间
及备份列表在反复同步中保持不变，没有因为兼容补丁产生额外重启。
移除原生加载对照脚本后，重新启动 Windows 客户端，常规加载路径也持续运行超过
60 秒；插件启用、数据库可读，`PRAGMA integrity_check` 返回 `ok`。

本次定向 Vitest 用例 24 项通过，两个改动 TypeScript 文件的 ESLint 和
`npm run compile:electron` 通过。验收关注插件启动及网关持续可用性；远端 503
等可恢复日志保留，不作为本次阻塞项处理。

`agent_end` / `llm_output` 的会话访问权限仍由 OpenClaw 检查，补丁没有自动授权。
macOS、Linux 及 QA 原机上的完整插件功能仍需回测。
