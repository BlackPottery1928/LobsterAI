# OpenClaw 插件异常时降级启动

## 1. 概述

### 1.1 问题

从 `release/2026.9.23` 的 `8a478bffa6422e2b1bb2e428de916672b1b1c7a7` 开始实施。该分支仍固定 OpenClaw `v2026.8.1`。

用户安装的 `memory-tencentdb` 包缺少 TypeScript 入口对应的编译产物，日志还包含 OpenClaw host peer link 不可用。升级后的启动收敛尝试修复插件，修复失败的 warning 被提升为 `OpenClaw plugin verification failed; refusing to report the gateway ready.`，导致整个客户端无法对话。升级该插件能绕过本例，但不能覆盖其他插件或其他可用性故障。

### 1.2 根因

8.1 已有基于安装根目录的插件隔离机制，却仅豁免部分 payload smoke warning。其他修复 warning、缺安装路径的 active record 仍阻断启动。`plugins.load.paths` 检查失败还可能使校验与 Doctor 将暂时无法检查的配置误判为过期。配置修复 hook 若直接修改输入后抛异常，也没有事务式隔离。

LobsterAI 停止重启是在响应网关的明确拒绝；只取消宿主的重启抑制不能恢复服务。因此在固定版本的上游运行时边界回移策略，宿主继续遵守实际 ready 状态。

## 2. 用户场景

1. 安装包缺编译入口、缺 host link，或插件升级失败：保留安装记录、启用设置及配置，隔离无法加载的插件，健康模型仍可新建和继续会话。
2. 配置的插件目录暂未挂载、权限不足或 I/O 检查失败：展示可定位的 warning，保留路径和无法检查的插件、channel、模型配置。
3. 插件配置修复 hook 抛错：丢弃该 hook 的局部配置修改，继续处理其他插件。
4. 插件修复成功后重启：重新检查 payload，清除该次启动的隔离状态，恢复插件。
5. 核心配置不合法、迁移租约失效、迁移输入变化或状态迁移无法确认安全完成：仍拒绝启动，保留原有修复和重试流程。

## 3. 功能需求

- 按故障归属与生命周期阶段处理，不按插件名、安装来源或报错文本设置豁免名单。
- 插件不可用不等于允许执行损坏插件。继续使用已有 loader quarantine 和安全校验。
- 修复不成功时保留配置与安装记录，不自动卸载、清空配置或关闭所有插件。
- 缺失路径与检查失败分别报告诊断类型；保留原始系统错误码和修复提示。
- 启动 checkpoint 已有效的路径也要重新验证插件并重建隔离状态。
- 验收必须经过真实 Electron renderer、preload、主进程、网关和持久化会话；不能用模块测试替代客户端实操。

## 4. 实现方案

### 4.1 版本补丁

新增 `scripts/patches/v2026.8.1/zzz-openclaw-plugin-degraded-startup.patch`，在已有补丁之后应用。源代码开发使用独立 OpenClaw worktree，最终行为以版本补丁为准；不提交生成的 vendor 运行时。

- `runtime-degraded-state` 定义共用的 `configured-unavailable / warning` 策略。
- 启动收敛继续记录修复告警和执行 payload 校验，移除插件 warning 的全局拒绝分支，覆盖无安装路径的 active record。
- discovery 为配置路径的缺失与检查失败记录 `configDisposition: preserve`；缓存与 SQLite 安装索引保留诊断字段。
- 校验、自动启用和 Doctor 清理在发现未检查路径时保护输入。不得由其他插件解释、迁移或删除无法确认归属的配置。
- Doctor 注册插件检查失败时产生 availability finding，并屏蔽当前调用中的过期回调；下一次健康调用仍可恢复。已注册检查报告的数据错误和重复检查 ID 仍保留原有失败处理。
- 纯配置修复 hook 使用独立候选配置，抛错时丢弃候选；状态写入迁移不适用此捕获策略。

### 4.2 上游来源与升级清理

以下发布归属通过 GitHub 提交祖先关系核对；不能仅凭 PR 合并时间判断。

| 上游 | 合并提交 | 本次关系 | 后续清理条件 |
| --- | --- | --- | --- |
| [#110239](https://github.com/openclaw/openclaw/pull/110239) | `cd1ab406322bbd4a735a4473c1f47a2c53ebf992` | 8.1 已包含安装根目录隔离基础 | 保持 loader 的隔离能力 |
| [#150016](https://github.com/openclaw/openclaw/pull/150016) | `eb8bca1326c485c8c8bf75a2c242b06415a1b6af` | 回移启动与 Doctor 的共用可用性策略，按 8.1 Doctor 注册结构适配 | 9.5 已包含；升级并通过端侧回归后删除对应部分 |
| [#150312](https://github.com/openclaw/openclaw/pull/150312) | `7a15658f54a9a093af43c6d68627b946cb8cf392` | 回移缺失/不可读配置路径的告警及配置保护，适配 8.1 单体校验模块 | 9.5 已包含；保留路径与配置恢复验收后删除对应部分 |
| [#154543](https://github.com/openclaw/openclaw/pull/154543) | `47be91106c07bc957820dc5bb726433b99f38c8f` | 回移纯配置修复 hook 输入隔离；不是该 PR 全部更新 CLI 行为的逐字移植 | 9.5 不包含；升级目标须含此提交或等价实现 |
| [#147711](https://github.com/openclaw/openclaw/pull/147711) | `dac3cb6d47c2387442b3e50327fe6346af6d3232` | 迁移延期账本、ACP 来源保留及新配置读写协议的后续参考；不能将本补丁视为整个 PR 的移植 | 9.5 已包含；升级时核对迁移延期与账本完成状态 |

[v2026.9.5](https://github.com/openclaw/openclaw/releases/tag/v2026.9.5) 于 2026-09-19 发布。其 [更新故障文档](https://github.com/openclaw/openclaw/blob/v2026.9.5/docs/install/update-troubleshooting.md#plugin-repair-warnings) 描述插件修复告警、配置保护和可用网关继续运行。9.5 之后上游仍继续完善 Doctor 与安全迁移边界，如 [#155389](https://github.com/openclaw/openclaw/pull/155389)。未来不能仅因版本号大于 9.5 就无条件删除全部补丁。

本补丁不将 8.1 的状态迁移 warning 全部降级；迁移写入是否完成仍由现有迁移所有者和 checkpoint 决定。缺插件时未执行的插件 hook 与原始输入保留，恢复插件后应通过 Doctor 重新检查。完整的 9.5 延期账本涉及配置读写、会话来源和数据库协议，不能以吞掉异常冒充迁移完成。

已有 `zz-openclaw-marketplace-clone-retry.patch` 保留其获取阶段的类型化错误及重试逻辑，但其“无安装路径仍阻塞”等旧启动策略由本补丁取代。升级时应分别核对获取流程与启动策略，不应将两份补丁一起盲目保留。

### 4.3 验收方式

从当前分支编译客户端及打过完整版本补丁的 OpenClaw。使用独立 appData 和会话工作目录；测试插件、历史标记和日志均在隔离目录。通过 Electron remote debugging / CDP 操作真实客户端，使用 DOM 和 IPC 检查状态、发送消息、重启网关及查看持久化结果。不使用 computer-use，不注入全局键鼠事件。

记录改动前后相同故障的对照、健康模型新会话和续聊、进程重启后会话保留、问题插件恢复，以及无效核心配置的反向用例。日志与截图在提交前去除访问令牌、真实账号标识及私人会话内容。

## 5. 边界情况

| 场景 | 处理 |
| --- | --- |
| 被隔离插件正是所选模型 provider | 网关可运行，该模型不可用；需选择健康模型 |
| 修复下载失败但旧插件仍通过校验 | 可继续使用旧插件并保留修复告警 |
| 未知路径下的插件所有者不能确定 | 保守保留相关配置，暂缓依赖该发现结果的自动修改 |
| 已存在用户显式禁用/拒绝设置 | 保留原设置，不因降级策略自动启用 |
| 核心 schema、SQLite 完整性或迁移锁错误 | 保持失败，不作插件可用性告警处理 |
| 运行中任意插件主动终止进程或破坏共享全局状态 | 不在启动隔离策略的保证范围；上游插件并非独立进程沙箱 |
| 插件迁移函数已经执行写入后抛错 | 保持迁移失败处理，不声称能够安全继续 |

## 6. 验收标准与结果

### 6.1 第一轮验收（2026-09-23 16:34，PR 先行）

| 检查 | 实际结果 |
| --- | --- |
| 健康基线 | Electron 界面创建会话，已登录账号的套餐 `deepseek-flash-YoudaoInner` 返回 `BASELINE-PLUGIN-OK`，消息持久化成功 |
| 原始故障包 | 使用 npm 原始 `@tencentdb-agent-memory/memory-tencentdb@0.2.2`，未补造编译入口；网关日志实际出现 `Failed to update memory-tencentdb: package install requires compiled runtime output for TypeScript entry ./index.ts` |
| 故障后的新会话 | 网关达到 ready，界面发起新会话，真实套餐模型返回 `DEGRADED-NEW-OK` |
| 故障后的原会话 | 打开故障前的会话，续聊返回 `DEGRADED-CONTINUE-OK`；IPC 读取同时包含故障前后消息 |
| 配置与数据 | `enabled: true`、allowlist、`e2ePreserve` 配置及工作区历史标记均保留 |
| 最终运行时冷启动 | 正在验收，尚不计为通过 |
| 缺失路径、其他安装异常及恢复 | 待完成端侧验收 |
| 核心配置无效的反向用例 | 待完成端侧验收 |

原始包 SHA-256：`f4d5c764bd991bdd4827590416bace144c273d6f1b9ce9da52e9e6a5c1d0af46`。该包通过安装记录参与真实启动收敛与 payload smoke check，不 mock 网关、IPC、模型服务或会话存储。

本机证据目录：`%TEMP%/lobster-plugin-degraded-e2e-20260923`。截图为 `01-baseline.png`、`02-memory-broken-new.png`、`03-memory-broken-continue.png`；隔离主日志与网关日志在该目录的 `appdata/LobsterAI/` 下。原始配置与登录凭据不提交。

### 6.2 构建与回归

- LobsterAI `npm run compile:electron`、`npm run build` 已通过。
- OpenClaw `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 pnpm build` 已通过；重新生成 Gateway bundle 与四个启动/修复 helper。验收复用已有运行时的未变更生产依赖；未制作安装包。
- 全新 `v2026.8.1` checkout 上完整 57 个版本补丁应用两轮成功；第二轮输出与开发源树的 46 个修改文件逐一一致。
- 修改的上游文件通过 `oxlint`、`oxfmt --check` 和核心 `tsgo`。`tsgo:prod` 的扩展阶段仍有既有 `extensions/openai/openai-provider.ts:170` 的 `lobsterai-model-compat` 类型错误；本补丁不修改该接口。
- 启动 checkpoint、迁移拒绝边界、插件修复 warning、Doctor 配置保护、纯配置 hook 回滚、Doctor 检查注册隔离及索引诊断持久化的定向测试已通过。Doctor lint 25 例已完整重跑通过；插件路径/索引定向测试 12 例通过，1 例 POSIX 权限测试在 Windows 跳过。两例 chmod-000 Doctor 测试同样在 Windows 跳过。

### 6.3 复验入口

`scripts/e2e-openclaw-plugin-degraded.cjs` 连接已用独立 appData 启动的真实 Electron。启动时指定 renderer 调试端口 `--remote-debugging-port=19533` 和 main 调试端口 `--inspect=19534`。仅在隔离测试配置中注入插件故障；实际登录账号通过客户端正常登录，不在命令行传密钥。

```powershell
node scripts/e2e-openclaw-plugin-degraded.cjs send --port 19533 --output <证据目录> --name broken-new --marker DEGRADED-NEW-OK
node scripts/e2e-openclaw-plugin-degraded.cjs send --port 19533 --output <证据目录> --name broken-continue --marker DEGRADED-CONTINUE-OK --session <原会话ID>
node scripts/e2e-openclaw-plugin-degraded.cjs restart --port 19533 --output <证据目录> --name restart
node scripts/e2e-openclaw-plugin-degraded.cjs capture --port 19533 --output <证据目录> --name result
node scripts/e2e-openclaw-plugin-degraded.cjs stop --port 19534
```

驱动通过 DOM 填写提示词和 CDP 发送 Enter，使用真实 preload IPC 读取最终回复并断言持久化结果；输出模型 ID、会话 ID、引擎状态和截图。停止命令触发应用自身的 SIGTERM 清理流程，避免退出确认对话框妨碍自动化。

第一轮通过后按用户要求先提交 PR 启动 CI。上述待验收项完成前，不将 PR 标记为发版验收完成。
