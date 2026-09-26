# 技能 Python 依赖预装设计文档

## 1. 概述

### 1.1 问题

Windows 安装包已经内置了可移植 CPython 3.11.9（`resources/python-win`，随
`build-tar/win-resources.tar` 分发，安装后抽出，运行时同步到 `%APPDATA%/LobsterAI/runtimes/python-win`
并注入 `PATH`）。但 `scripts/setup-python-runtime.js` 的头部注释写得很明确：
**"Bundles interpreter runtime only (no preinstalled skill dependencies)"**。

后果：

技能的 Python 依赖（`lxml` / `python-pptx` / `pypdf` / `openpyxl` …）只在 `SKILL.md` 里以散文形式
写着 `pip install ...`。用户首次运行技能时必须联网 pip 安装；在内网/纯离线环境里，技能直接不可用，
而且报错点离"这是打包问题"很远，排查成本高。

### 1.2 目标

1. **构建期可选能力**：把内置技能的 Python 依赖预先下载并打进安装包，部署后开箱即用，运行时零联网。
2. **`SKILLs` 下新增依赖配置文件**：一张扁平表，Python 依赖必须固定版本号（`==`），并包含一组常用依赖。
3. **支持从本地目录取依赖**：构建可用本地 wheel 缓存离线出包，无需访问 PyPI。
4. **尽量少改原生代码**，便于后续合并主干。

### 1.3 边界（本期不做）

- **仅 Windows**。只有 Windows 打包 Python 运行时，mac/linux 检测到无内置运行时即跳过并打日志，
  `dist:mac` / `dist:linux` 行为完全不变。
- **不处理非 pip 的系统二进制**：poppler（`pdf2image`）、tesseract（OCR）、LibreOffice（文档转 PDF）
  无法通过 pip 分发，在 `docs/skill-python-deps.md` 里记录为已知限制，不做打包。
- **不做用户自扩展依赖**：只预装内置技能的依赖。用户自定义技能需要的额外包没有受支持入口，
  只能首次运行时联网安装 —— 这正是本能力为内置技能解决的问题。
- **不做已装依赖的卸载/回收**：`pip install` 不会主动移除不再需要的包，残留包无害。

---

## 2. 用户场景

### 场景 1：离线环境首次使用内置技能

**Given** 用户在内网环境安装 LobsterAI（安装包在构建机联网时产出）
**When** 用户让 agent 用 docx 技能生成一个 Word 文档
**Then** 技能脚本直接运行成功，全程没有任何 pip 网络请求

### 场景 2：内网构建机出包

**Given** 构建机不能访问 PyPI，但 wheel 缓存已由一台联网机器播种
**When** 执行 `npm run dist:win`
**Then** 预检在本地解析成功，整场构建不访问网络

### 场景 3：老版本升级

**Given** 用户从没有本能力的旧版本升级上来，`runtimes/python-win` 已存在但不含预装依赖
**When** 用户首次启动新版本
**Then** 应用检测到 bundled 依赖清单指纹与 userData 不一致，重新同步运行时，日志明确打出原因

---

## 3. 功能需求

### FR-1: 依赖配置文件

`SKILLs/python-deps.json`（提交进仓库）是一张**扁平表**，只有一个 `packages` 映射，形如
`"lxml": "==6.1.3"`。

刻意没做的几件事（初版做得太重，已收敛）：

- **没有 groups / defaultGroups**：分组是复杂度的大头。可选的大包（`anthropic`）改为不预装，
  只在 `docs/skill-python-deps.md` 里写清后果。
- **没有 skills 映射**：机器校验交给 `tests/skillPythonDepsCoverage.test.ts` 从反方向做——
  它扫描已分发技能的 `.py` 的第三方 import，表里缺什么就失败。这样表可以保持扁平，同时仍然"诚实"。
- **没有 excludedPackages / nonPipRequirements**：纯文档，移到 `docs/skill-python-deps.md`。
- **没有 deniedPackages**：`pip`/`setuptools`/`wheel` 改为代码里的常量 `DENIED_PACKAGES`——
  需要改这份名单的场景应该走代码评审，而不是改一个配置文件。

占位符 `==0.0.0` 表示"尚未解析"。校验器会拒绝占位符，因此构建不可能带着未解析的版本发版；
填充由 `--resolve --write` 从索引解析后写入。

### FR-2: 校验即中断构建

`scripts/skill-python-deps.cjs` 对标 `scripts/skill-exclusions.cjs`：任何校验失败都抛错并中断构建。
校验项：pin 必须是精确 `==`、包名合法、不含 LobsterAI 自有的包、包表非空、`target` 三项齐全。

### FR-3: 构建期预装

`node scripts/setup-skill-python-deps.js`：

1. 解析并校验配置；
2. **预检**：`pip install --dry-run --ignore-installed --no-index --find-links <cache> <pins>`，
   在本地对 wheel 缓存解析完整传递闭包；
3. 预检不通过时：`--offline` 直接报错；否则用内置运行时的 pip 以
   `--only-binary=:all: --platform win_amd64 --python-version 311 --implementation cp` 执行
   `pip download -d <cache>`（下载后才真正联网）；
4. `pip install --no-index --find-links <cache>` 装进 `resources/python-win/Lib/site-packages`
   —— 这一步永远不联网；
5. 写 `python-deps-manifest.json`；
6. 用 `importlib.metadata` + 实际 `import` 做校验（版本号比不出缺 DLL），并确认 `python3.dll` 存在。

预检里的 `--ignore-installed` 是必需的：否则 pip 会以"requirement already satisfied"回答，
而这个判断基于目标运行时里**已经装了什么**，于是一个空缓存会被误判为完整、wheel 永远不会被缓存。

**没有 lock 文件**：配置里的 pin 就是唯一事实来源，传递闭包交给 pip 在构建时解析。代价是安装不做
哈希校验 —— 重建时未改动 pin 的传递依赖可能被解析到更新版本；离线缓存靠"本地解析是否可满足"来验证，
而不是比 sha256。

可用 `LOBSTERAI_SKILL_PYTHON_DEPS_SKIP=1` 关闭，退回"只带解释器"的旧行为。

### FR-4: 打包接线

- `package.json`：`pack` / `dist` / `dist:win` 在 `setup:python-runtime` 之后串联
  `setup:skill-python-deps`；**`dist:win` 的 `npm run verify:installer-patches && ` 前缀必须保留**
  （被 `tests/windowsInstallerContract.test.ts` 钉住）。
- `scripts/electron-builder-hooks.cjs`：依赖安装必须落在 `beforePack` 内、**tar 打包之前**。
  不能只挂在 npm script 上，因为 `scripts/dist-win-web.cjs` 会绕过 `dist:win` 的脚本链直接调
  electron-builder。

### FR-5: 运行时指纹比对

- 构建侧写 `resources/python-win/python-deps-manifest.json`，含 `manifestId`
  （对 `{pins, scriptVersion}` 的规范化 JSON 求 sha256，**故意排除 `generatedAt`**）。
- 运行时 `src/main/libs/pythonRuntime.ts`：userData 运行时健康但两侧 `manifestId` 不一致时重新同步。
  bundled 侧无清单（开发态）一律视为"不需要重新同步"，行为与改动前一致；清单缺失/损坏等同于"无清单"，
  避免一次损坏导致每次启动都重拷几十 MB。

---

## 4. 实现方案

### 4.1 依赖为什么装进 `Lib/site-packages`

内置 embed 分布的 `._pth` 已由 `setup-python-runtime.js` 配上 `Lib\site-packages` + `import site`，
`sys.prefix` 就是运行时根目录。因此把包装进 `Lib/site-packages` 之后，它随
「运行时 → tar → 安装目录 → userData」这条既有链路自动到达用户机器，**运行时侧零新增代码**。
这是"少改原生代码"的关键：没有新增运行时装配逻辑，也没有新的环境变量。

### 4.2 闭包交给 pip，代码不自己算

11 个声明 pin 的传递闭包是 18 个包，但这份闭包**不由本仓库维护**：pip 在预检/下载/安装时自己解析。
初版曾把闭包固化进 lock（含 sha256 与 `requires` 边，再自己算闭包裁剪），后来整块删掉了 ——
它是配置复杂度与代码量的主要来源，而收益只是哈希可复现，对"技能开箱可用"这个目标没有贡献。

`--resolve` 仍会跑一次带 `--report` 的解析，但只用来把 `==0.0.0` 占位符换成真实版本写回配置。

### 4.3 pip shim 不能被覆盖

内置运行时的 `Scripts/pip*` 与 `Lib/site-packages/pip/__main__.py` 是 LobsterAI 自有文件
（与 `src/main/libs/pythonPipShim.ts` 有逐字节一致契约，由 `pythonPipShim.test.ts` 断言）。
`DENIED_PACKAGES`（代码常量）禁止 pin `pip`/`setuptools`/`wheel`；安装后还会断言这些文件仍在，
缺失即构建失败。安装产生的 `Scripts/*.exe` 与 `Scripts/__pycache__` 会被清理，`.pyc` 保留
（由内置 3.11 编译，magic number 与目标一致，首跑导入更快）。

### 4.4 涉及文件

**新增**

| 文件 | 作用 |
|---|---|
| `SKILLs/python-deps.json` | 依赖配置（人工维护，唯一事实来源） |
| `scripts/skill-python-deps.cjs` | 配置加载/校验、清单 id |
| `scripts/setup-skill-python-deps.js` | 解析 / 预检 / 下载 / 安装 / 校验 / 写清单 |
| `src/main/libs/pythonRuntime.test.ts` | `readDepsManifestId` / `shouldResyncPythonRuntime` 单测 |
| `tests/skillPythonDeps.test.ts` | 配置校验、清单 id、wheel 缓存不进包（对标 `tests/skillExclusions.test.ts`） |
| `tests/skillPythonDepsCoverage.test.ts` | 内容审计：已分发技能的第三方 import 必须被覆盖，否则记入 `INTENTIONALLY_NOT_BUNDLED` |
| `docs/skill-python-deps.md` | 维护者文档 |
| `specs/features/skill-python-deps-bundling/*.md` | 本文档 |

**修改（刻意压到最少）**

| 文件 | 改动 |
|---|---|
| `package.json` | 2 个新脚本 + `pack`/`dist`/`dist:win` 各一处串联 |
| `scripts/electron-builder-hooks.cjs` | +1 require，`beforePack` 内 +3 行（把"准备运行时"提前到打包之前） |
| `src/main/libs/pythonRuntime.ts` | 新增 `readDepsManifestId` / `shouldResyncPythonRuntime`；健康分支加指纹判断；`runtime.json` 增记 `depsManifestId` |
| `.gitignore` | 新增 `.cache/`（wheel 缓存的宿主目录） |

`ensureEmbedSitePackages`、`src/main/main.ts` 与 pip shim 相关文件都保持原样 —— 内置预装不需要
运行时装任何东西，依赖随运行时目录自己到达用户机器。

**零改动**：`scripts/pack-openclaw-tar.cjs`、`scripts/setup-python-runtime.js`、
`src/main/libs/pythonPipShim.ts`、`electron-builder.json`、`scripts/nsis-installer.nsh`、
`src/main/skills/*`、`SKILLs/skills.config.json`。

---

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| mac/linux 构建 | 静默跳过并打 `Windows-only capability; skipping on <platform>`，退出码 0 |
| `LOBSTERAI_SKILL_PYTHON_DEPS_SKIP=1` | 跳过预装，产出只带解释器的安装包（旧行为） |
| 占位符 `==0.0.0` 未解析 | 校验器抛错并提示跑 `--resolve --write`，构建中断 |
| 配置里 pin 了 `pip` | 抛错，构建中断（会覆盖内置 pip shim） |
| 引脚版本索引上不存在 | `--resolve` 时 pip 解析失败并抛错，构建中断 |
| 离线模式但 wheel 缓存不满足 | 预检失败后直接抛错（fail loud），提示播种缓存 |
| 构建机无外网且缓存为空 | `--required` 下构建失败（刻意 fail loud，避免发出不完整运行时） |
| 目标运行时已装好依赖、缓存却是空的 | 预检用 `--ignore-installed`，不会被"already satisfied"骗过，仍会去下载 |
| wheel 缓存里混入了其他平台的 wheel | 这类 wheel 满足不了预检（预检跑在运行时自身的 3.11/win 解释器上），判定为不满足并触发重新下载 |
| userData 运行时健康但清单不同 | 重新同步并打印 `Bundled skill dependencies changed (… -> …)` |
| bundled 运行时无清单（开发态） | 永不重新同步，行为与改动前一致 |
| 清单文件损坏/为空 | 视为"无清单"，不触发重新同步（否则每次启动都会重拷） |
| 用户往 userData 运行时目录里手工 pip install | 不阻止，但下次重新同步会 `rmSync` 掉；文档中说明不支持 |

---

## 6. 验收标准

1. `npm test` 全绿（本能力相关测试通过；另有一批与本改动无关的既有失败，见第 7 节）。
2. `npm run compile:electron` 与改动文件的 ESLint（`--max-warnings 0`）通过。
3. `npm run setup:python-runtime && npm run setup:skill-python-deps` 后：
   `resources/python-win/python.exe -c "import lxml.etree, defusedxml, docx, pptx, PIL, pypdf, openpyxl, yaml, six, requests, pdf2image"` 成功。
4. 重复执行 `npm run setup:skill-python-deps` 快速短路（幂等）。
5. **删掉 `resources/python-win` 重新生成后，`--offline` 能从 wheel 缓存装出全部 18 个包并通过 import
   冒烟**（真正的离线验证：安装步骤用 `--no-index`，任何联网需求都会让它失败）。
6. 空缓存 + `--offline` 必须响亮失败；空缓存 + 联网必须下载出完整闭包（18 个 wheel）。
7. `build-tar/win-resources.tar` 内包含 `python-win/python-deps-manifest.json` 与
   `python-win/Lib/site-packages/` 下的新包；**解包后的运行时实测可 import**（比只看 tar 列表更接近真实产物）。
8. 安装该安装包后，`userData/runtimes/python-win` 的 `runtime.json` 中 `depsManifestId` 与 bundled 一致。

---

## 7. 实测数据与已知取舍

### 体积（本机实测，Windows x64）

| 项 | 数值 |
|---|---|
| 基线运行时 | 34 MB（`du`；脚本自计 31.4 MB） |
| 安装全部声明包后 | 84 MB，即**解包后 +45~50 MB** |
| wheel 缓存（压缩） | 18 MB |
| （参考）若把 anthropic 也预装 | 另 +21.7 MB（pydantic-core / jiter），已决定不装 |

结论：安装包体积增长接近 wheel 压缩后的大小（约 +20~25 MB），而**解包后**增长约 50 MB。
`writeWindowsPayloadSizeFragment` 会把解包体积写进 NSIS 定义、安装器据此预检可用空间，
因此最小磁盘要求会自动抬高，QA 需复测该路径。最大单项是 Pillow（16 MB）。

### 已放弃的方案

- **`--abi cp311`**：会收窄可接受的 ABI 集合、把合法的 `abi3` wheel 排除掉，因此不传。
- **`markitdown[pptx]`**：会拖入 magika → onnxruntime（约 100 MB）；
  `pptx/SKILL.md` 本就标为可选，记入 `docs/skill-python-deps.md`。
- **`anthropic` 走"可选分组"**：先做过 groups + defaultGroups，但分组是整个配置复杂度的大头，
  而收益只是让两个 eval 脚本离线可用。最终改为**不预装**，把后果写进 `docs/skill-python-deps.md`，
  并在覆盖率测试里以 `INTENTIONALLY_NOT_BUNDLED` 显式记录，避免变成无人知晓的遗漏。
- **配置里的 `skills` 映射 / `excludedPackages` / `nonPipRequirements` / `deniedPackages`**：
  初版把它们都放进 `python-deps.json`，结构过重。最终 skills 映射由覆盖率测试从反方向承担，
  纯文档项移入 `docs/`，`deniedPackages` 改为代码常量，配置收敛成一张扁平表。
- **`python-deps.lock.json`（闭包 + sha256 + `requires` 边 + 自算闭包裁剪）**：
  这是配置和代码复杂度的大头（`collectClosure`、`verifyWheelhouse` 的哈希校验、
  `applyResolution` 的闭包写盘、lock 的解析与对称性校验），而收益只有"哈希可复现"。
  整块删掉，改为「配置里的 pin 是唯一事实来源 + pip 在构建时现场解析」。
  代价：不做哈希校验；离线缓存靠本地解析是否可满足来验证。
- **wheel 缓存放在 `resources/pip-wheelhouse/`**：`resources/` 里的东西是**部分会进安装包**的
  （`extraResources` 与 Windows tar），把构建缓存放进去只差一个 `resources/**` 通配符就会把
  18 MB wheel 一起发出去。改到 `.cache/pip-wheelhouse/`，并用测试把"不进包"钉住。
- **用户自扩展依赖（`userData/python-deps/` + `src/main/libs/pythonUserDeps.ts`）**：
  做过一版——用户写 `requirements.txt`、丢 `wheels/`，应用启动时装进独立的 `site-packages`
  并往 `._pth` 追加一行（必须走 `._pth`，因为存在 `._pth` 时解释器是 isolated 模式、
  `PYTHONPATH` 被忽略）。后来按要求**先只做内置**，整块移除，`ensureEmbedSitePackages` 也回到原样。
- **放宽 tar 的排除表以保留 `site-packages` 里的 `tests`/`readme`**：改为「解包后实测 import」来验证
  真实产物，避免削弱 cfmind/SKILLs 也依赖的全局排除规则。

### 已知风险

1. **升级首次启动会同步阻塞**：清单变化会触发 `rmSync` + 整目录拷贝，且跑在 `initApp` 的
   `Promise.all` 里、是同步的，会推迟窗口出现。先接受这个一次性成本，发布说明需提示；
   若现场反馈卡顿，后续再挪进 `utilityProcess`。
2. **残留包**：`pip install` 不卸载。CI 每次从缓存 zip 重建运行时，所以分发的产物是干净的；
   只有本地开发机的 `resources/python-win` 会累积。
3. **无用户自扩展入口**：用户自定义技能需要的额外包只能在首次运行时联网安装，离线环境下不可用。
   这是本期刻意收敛的范围，不是遗漏（见第 7 节）。
4. **与本改动无关的既有测试失败**：全量 `npm test` 有 42 项失败（15 个文件，涉及 Windows 符号链接
   EPERM、better-sqlite3 未构建、openclaw 运行时缺失等），已在干净工作树上复现确认与本改动无关。
