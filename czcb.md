## 精简设置页面
## 修改登录

内网构建改用内网权限接口登录（工号 + OA 密码），不再走「系统浏览器门户 + 回环回调」链路。

### 合并上游主干前的还原办法

`grep -rn "INTRA-ONLY" src` 就是完整清单 —— 该功能在上游文件里的每一个 hunk 都带这个标记。

**第一步：删掉这些新增文件/目录（删干净即可，无残留引用）**

- `src/shared/intranetAuth/`
- `src/main/libs/intranetEndpoints.ts` 及其 `intranetEndpoints.test.ts`
- `src/main/libs/intranetAuthLogin.ts` 及其 `intranetAuthLogin.test.ts`
- `src/main/ipcHandlers/intranetAuth/`
- `src/renderer/services/intranetCredentialLogin.ts`
- `src/renderer/components/auth/`

**第二步：还原下列上游文件的改动**

| 文件 | 改动 |
| --- | --- |
| `src/main/libs/endpoints.ts` | import + `getUpdateCheckUrl` / `getManualUpdateCheckUrl` 改成基于 `getIntranetBaseUrl()` 拼接；**其余地址（含 `getServerApiBaseUrl()`）与上游一致** |
| `src/main/main.ts` | 2 处 import + 一处 `registerIntranetAuthIpcHandlers({...})` 调用 |
| `src/main/preload.ts` | import + `auth.loginWithCredentials` |
| `src/renderer/services/auth.ts` | 2 处 import + `login()` 里的开关分支 + `destroy()` 里一行 |
| `src/renderer/services/auth.test.ts` | `describe('login diagnostics')` 整段被改写（上游原用例测的是浏览器跳转，开关打开后不可达） |
| `src/renderer/services/i18n.ts` | zh / en 各一组 `intranetLogin*` 文案 |
| `src/renderer/App.tsx` | 2 处 import + 挂载 `<IntranetCredentialLoginView />` |
| `src/renderer/components/StartupCreditCampaign.tsx` | import + `redirectUrl` 守卫 |

### 临时关闭（不删代码）

把 `src/renderer/components/auth/intranetLoginVisibility.ts` 里的
`INTRANET_CREDENTIAL_LOGIN_ENABLED` 置为 `false`，即回到浏览器门户登录。
`src/renderer/components/artifacts/artifactDeployVisibility.ts` 是同一套写法。

### 接口契约

默认约定写在 `src/main/libs/intranetAuthLogin.ts` 顶部 `--- Service contract ---`
段落：登录路径、请求/响应字段名、超时。真实接口文档到位后只改这一段。

base URL 三级优先级：

1. `LOBSTER_INTRANET_AUTH_BASE_URL`（最高，任意 http(s) 绝对 URL）
2. `INTRANET_BASE_URL` 常量（`src/main/libs/intranetEndpoints.ts`，默认 `http://127.0.0.1:8080`）
3. 上游 `getServerApiBaseUrl()`（把常量置为 `''` 即回到这一级）

### 取消登录不报错

表单里按 Esc 或点「取消」→ `AuthLoginResult.cancelled = true`
（`src/shared/auth/constants.ts`，`[INTRA-ONLY]` 字段，与 `error` 分开），
`src/renderer/services/intranetCredentialLogin.ts` 在两处取消分支上置位。

四个会检查登录结果的调用点据此**不再弹「登录发起失败」类提示**：
`App.tsx`（新用户引导）、`CoworkPromptInput.tsx`（提示框登录）、
`DailyCheckInActivity.tsx`（每日签到）直接静默返回，`StartupCreditCampaign.tsx`
（积分活动弹窗）额外把弹窗关掉而不是显示 Failed 视图。
其余调用点（`LoginButton`、`ModelSelector` 等）本来就不看返回值。

### 已知边界

**只有登录与自动更新被指向内网，刷新等其它认证/主服务端请求仍打上游。** 这是有意的取舍：
`getServerApiBaseUrl()` 同时是模型推理代理的 base（`/api/proxy/v1`），整体改指向会让推理链路一起断。

代价是：内网 token 交给现有服务端会 401，而 401 会触发 `AuthSessionManager` 的
terminal refresh（`POST {上游}/api/auth/refresh` 同样 401）→ 清会话。触发点是**窗口聚焦的
配额检查**（`/api/user/quota`）与**下次启动的 `authService.init()`**。也就是说，
登录能用，但「聚焦窗口或重启后被登出」在这个组合下是预期行为；
要消除它，需要把刷新链路一起指到内网（见 §9）。

## 修改积分提示
## 修改对话模型

## 与有道交互的接口

内网部署需要确认「哪些出网请求必须放通、哪些必须屏蔽」。下表是应用**主动发起**的
全部有道侧请求；行号对应当前 `dev` HEAD `2732ef8a`。除注明外都由主进程发起。

### 域名总览

| 域名 | 用途 | 触发时机 |
| --- | --- | --- |
| `lobsterai-server.youdao.com` | 账号、额度、模型目录、媒体生成、分享/部署、推理代理、ASR 会话 | 主服务端，几乎全程 |
| `lobsterai-server.inner.youdao.com` | 同上，仅 `testMode=true` 时 | 测试开关打开时 |
| `api-overmind.youdao.com` | 自动更新、Skill/Kit 商店、MCP 市场、登录地址 | 启动后 / 打开对应面板（**更新已改指内网**，见 §9） |
| `lobsterai.youdao.com` | Portal 页面、下载页、文档（全部走系统浏览器） | 点相关入口时 |
| `openapi.youdao.com` | 有道智云 LLM 网关 | 仅当用户自己填有道 API Key |
| `rlogs.youdao.com` | 埋点上报 | 默认已关（见 6） |

### 1. 主服务端 `lobsterai-server[.inner].youdao.com`

统一入口 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts:31-49`），按 `testMode`
在 prod / inner 之间切换；`testMode` 默认 `false`（`src/renderer/config.ts:207`），
即**默认指向 `lobsterai-server.youdao.com`**。所有带鉴权请求走
`fetchWithAuth`（`src/main/main.ts:5367`）：注入 Bearer、自动刷新 token、附加企业头。

| 接口 | 位置 | 用途 |
| --- | --- | --- |
| `/api/auth/exchange` | `src/main/main.ts:7068` | 浏览器回调换取 token |
| `/api/auth/refresh` | `src/main/main.ts:5329` | token 刷新 |
| `/api/auth/logout` | `src/main/main.ts:7520` | 登出 |
| `/api/user/profile` | `src/main/main.ts:7213` | 用户资料 / 企业上下文 |
| `/api/user/profile-summary` | `src/main/main.ts:7351` | 资料摘要 |
| `/api/user/quota` | `src/main/main.ts:7246`、`7318`；`src/main/libs/startupCacheWarmup.ts:67` | 积分额度、订阅门禁 |
| `/api/models/available` | `src/main/main.ts:5409`；`startupCacheWarmup.ts:89` | 服务端模型目录 |
| `/api/models/pricing-catalog` | `src/main/main.ts:7557` | 价格表（无鉴权） |
| `/api/proxy/v1/*` | `src/main/libs/openclawTokenProxy.ts:219`、`src/main/libs/claudeSettings.ts:509` | **模型推理代理**（见 4） |
| `/api/media/{images,videos}/models` | `src/main/main.ts:5847`、`8358` | 图像/视频模型列表 |
| `/api/media/{images,videos}/generate` | `src/main/main.ts:6053`、`6270` | 生成任务提交 |
| `/api/media/{type}/tasks/{id}` (`/cancel`) | `src/main/main.ts:5906`、`6565`、`6031`、`8402` | 任务轮询 / 取消 |
| `/api/client-banners/{active,active-list,snapshot}` | `src/main/main.ts:7411`、`7428`、`7446`、`7482` | 侧边栏运营位（无鉴权） |
| `/api/client-activities/{slot,context,actions}` | `src/main/libs/activity/activityClient.ts:84`、`99`、`117` | 活动/积分领取 |
| `/api/credits-reset-campaign/free-credits/claim` | `src/main/main.ts:7384` | 积分重置活动领取 |
| `/api/enterprise/{context,identities}`、`/{id}/quota-requests` | `src/main/enterpriseAccount/context.ts:280`、`369`、`442` | 企业版账号 |
| `/api/asr/realtime/sessions` | `src/main/ipcHandlers/asr/handlers.ts:66` | ASR 会话（见 5） |
| `/api/html-shares/*` | `src/main/libs/htmlShare/htmlShareClient.ts:379-748` | HTML 分享上传/管理/配额 |
| `/api/sites/*`、`/api/share-deployments/*` | `src/main/libs/site/siteClient.ts:102-216`、`src/main/libs/shareDeployment/shareDeploymentClient.ts:379-572` | 网站部署 CRUD、配额、持久化 |
| `/api/library/cloud-items` | `src/main/library/libraryCloudClient.ts:321` | 云端文件库列表 |

### 2. `api-overmind.youdao.com`（更新 / 商店 / 市场）

六个路径，prod/test 由 `testMode` 切换。**更新那两个已经被指到内网**（见 §9），
其余四个仍**没有 host 级覆盖**。

| 接口 | 位置 | 用途 |
| --- | --- | --- |
| `…/lobsterai/{test,prod}/update` | `src/main/libs/endpoints.ts:65-67` | 自动检查更新（**已指内网**） |
| `…/lobsterai/{test,prod}/update-manual` | `src/main/libs/endpoints.ts:69-71` | 手动检查更新（**已指内网**） |
| `…/lobsterai/{test,prod}/skill-store` | `src/main/libs/endpoints.ts:73-77` | Skill 商店 |
| `…/lobsterai/{test,prod}/kit-store` | `src/main/libs/endpoints.ts:87-91` | Kit 商店 |
| `…/lobsterai/{test,prod}/login-url` | `src/renderer/services/endpoints.ts:37-39` | 解析 SSO 登录地址 |
| `…/lobsterai/{test,prod}/mcp-marketplace` | `src/main/ipcHandlers/mcp/handlers.ts:347-349` | MCP 市场 |

### 3. Portal 与文档（系统浏览器打开，非应用内请求）

`lobsterai.youdao.com/portal#` 与 `lobsterai.inner.youdao.com/portal#` 两侧同构，
定义在 `src/main/libs/endpoints.ts:80-85` 与 `src/renderer/services/endpoints.ts:42-101`：
登录页、定价、profile、积分明细、充值、邀请、积分重置活动、企业 profile/console
（overview / usage / billing / recharge）。下载页 `/ #/download-list`（`endpoints.ts:67-71`）。

以下为**硬编码、无任何覆盖**：文档与 IM 机器人配置指南
`src/shared/platform/constants.ts:42-129`、服务条款
`src/renderer/components/Settings.tsx:969` 与 `WelcomeDialog.tsx:5`、
有道智云官网/控制台 `src/shared/providers/constants.ts:355-356`。

### 4. 模型推理的两条链路

1. **自带 Key**：provider id `youdaozhiyun`（不是 `youdaoil`），默认 baseUrl
   `https://openapi.youdao.com/llmgateway/api/v1/chat/completions`
   （`src/shared/providers/constants.ts:358`），OpenAI 格式固定，Key 由用户填，
   baseUrl 用户可改。
2. **LobsterAI 套餐**：OpenClaw runtime → 本地代理
   `http://127.0.0.1:<随机端口>/v1`（`src/main/libs/openclawConfigSync.ts:954-956`）→
   `https://lobsterai-server.youdao.com/api/proxy/v1/*`
   （`src/main/libs/openclawTokenProxy.ts:219`，逐请求注入/刷新 `accessToken`）。
   Claude 线同理，`ANTHROPIC_BASE_URL` 指向 `{base}/api/proxy/v1`
   （`src/main/libs/claudeSettings.ts:941`）。

### 5. 语音 ASR

先 `POST {base}/api/asr/realtime/sessions` 换会话（`handlers.ts:66`，返回 `wsUrl`、
`chunkIntervalMillis`、`maxSessionSeconds`、`remainingSecondsToday`），再连服务端给的
`wsUrl` 流式传 PCM16（`src/renderer/services/voiceInput/realtimeAsrClient.ts:168`）。
**wsUrl 由服务端下发，客户端不硬编码**——屏蔽时不能只拦 `lobsterai-server`，
WS 目标域名需单独确认。

### 6. 埋点

`https://rlogs.youdao.com/rlog.php`（`src/shared/analytics/constants.ts:2`），
渲染进程 `src/renderer/services/logReporter.ts:196`、主进程
`src/main/libs/mainLogReporter.ts:72`，身份信息直接拼在 query 里（uuid、版本、os、
是否订阅）。两个开关位：默认值已改为 `false`（`src/renderer/config.ts:196`），
设置页开关被 `display: none` 隐藏（`src/renderer/components/Settings.tsx:5073-5086`）。
**注意**：这是持久化配置项，若用户目录里已存在旧配置且值为 `true`，
改默认值不会回写，需要在设置页或库里手动改。

### 7. 内网登录

`POST {base}/api/auth/login`（默认约定见 `src/main/libs/intranetAuthLogin.ts:19-27`）。
base 取 `LOBSTER_INTRANET_AUTH_BASE_URL`，未设置时回退到 `INTRANET_BASE_URL`
常量（`src/main/libs/intranetEndpoints.ts`，默认 `http://127.0.0.1:8080`），
常量置空才回到上游 `getServerApiBaseUrl()`。开关
`INTRANET_CREDENTIAL_LOGIN_ENABLED`
（`src/renderer/components/auth/intranetLoginVisibility.ts:6`），打开后不再请求
overmind 的 `login-url`。

**刷新（`/api/auth/refresh`）不在此列**，仍打上游 —— 见「修改登录 / 已知边界」。

### 8. 本分支已关闭的入口

| 开关 | 位置 | 屏蔽的接口 |
| --- | --- | --- |
| `ARTIFACT_SHARE_HIDDEN = true` | `artifactFileSharePolicy.ts:17` | `/api/html-shares/*` 全部入口 |
| `ARTIFACT_DEPLOY_HIDDEN = true` | `artifactDeployVisibility.ts:4` | `/api/sites/*`、`/api/share-deployments/*` |
| `CLOUD_SOURCE_HIDDEN = true` | `LibraryView.tsx:217` | `/api/library/cloud-items` |
| `SERVER_MODEL_WARMUP_ENABLED = false` | `startupCacheWarmup.ts:32` | 启动时 `/api/models/available` 预取 |

**只是隐藏 UI 入口，主进程 IPC handler 仍然注册**：手动调 IPC 或走残留代码路径仍能
打到这些接口。要真正断掉得在 net 层拦。

### 9. 可改写性汇总

| 目标 | 是否可改写 |
| --- | --- |
| 主服务端 base | 环境变量 `LOBSTER_SERVER_BASE_URL`，但**仅 dev 且未打包**，且必须是字面回环地址带显式端口（`src/main/libs/developmentServerBaseUrl.ts:17-44`，非回环直接抛错）。**本次没有改动它** |
| 内网登录 base | 常量 `INTRANET_BASE_URL`（`src/main/libs/intranetEndpoints.ts:31`，默认 `http://127.0.0.1:8080`）+ 环境变量 `LOBSTER_INTRANET_BASE_URL` 覆盖，任意 http(s) 绝对 URL，**打包版生效**；置为 `''` 回到上游 |
| 自动更新 base | 同上一行的两个开关（`getUpdateCheckUrl` / `getManualUpdateCheckUrl`，`src/main/libs/endpoints.ts:61-71`）；**其余四个 overmind 接口不受影响** |
| overmind 商店/市场 / portal / 文档 / rlogs / 有道智云 | **无 host 覆盖**，只能靠 prod/test 切换或整体关闭 |
| 模型 baseUrl | `youdaozhiyun` 可在设置里改；套餐链路不可改，且仍指向 `getServerApiBaseUrl()` |

三条通用约束：

- **必须是裸 origin**：`new URL(x).origin` 会丢掉 path，`http://gw.corp/lobsterai`
  会静默变成 `http://gw.corp`，然后所有请求 404。
- **环境变量对 Finder 双击启动的 .app 不生效**（macOS 不继承 shell 环境；Windows 的
  用户级环境变量则会继承）。所以**常量才是生产机制**，环境变量只是联调/排障用。
- 生效时日志里会有一行 `[Endpoints] routing intranet login and update traffic to <origin>`。

### 10. 已知边界

- **主服务端流量在打包版仍然改不了**（唯一的口子是 dev + 未打包 + 回环地址），
  本次也没改 `getServerApiBaseUrl()`。内网部署要么放通 `lobsterai-server.youdao.com`，
  要么改 `getServerApiBaseUrl()` —— 但那会连带把模型推理代理指向内网，需要同时处理
  「修改对话模型」。
- 渲染进程有一个无 host 白名单的通用 HTTP 代理 IPC `api:fetch`
  （`src/main/main.ts:13181-13266`，`src/main/preload.ts:248`），埋点、`login-url`、
  模型连通性测试都走它。想从 net 层收口必须把它算进去。
- `/api/event_logging/batch` 是**本地桩**，由 `coworkOpenAICompatProxy.ts:2381`
  直接返回 `{ok:true}`，不出网。
- ASR 的 `wsUrl` 由服务端下发（见 5）。
- 未关闭但内网用不到、仍会打外网的：**token 刷新**、Skill/Kit/MCP 三个商店、
  侧边栏运营位、活动/积分、企业版接口、媒体生成、推理代理。
  （自动更新已改指内网，见 §9。）

## overmind 接口字段明细（内网实现用）

自动更新（`update` / `update-manual`）、Skill 商店（`skill-store`）、Kit 商店
（`kit-store`）、MCP 市场（`mcp-marketplace`）、登录地址（`login-url`）五个接口的
请求/响应契约。全部定义在 `src/main/libs/endpoints.ts`、`src/renderer/services/endpoints.ts`，
消费方见各小节。

### 共同约定

- **方法**：全部 `GET`，无请求体。
- **鉴权**：全部无。没有任何 token / cookie / 签名。
- **信封**：`{ code, data: { value } }`，**`code` 必须严格等于 `0`**（数字 0）。
- **`value` 是对象还是 JSON 字符串，两种都要能解析**：Skill / Kit / MCP / 登录地址
  四处客户端都写了 `typeof value === 'string' ? JSON.parse(value) : value`。
  自动更新的 `value` 只按对象解析。
- **传输层不一致，内网要实现两种**：

  | 接口 | 传输 | 超时 | 代理 |
  | --- | --- | --- | --- |
  | update / update-manual | `session.defaultSession.fetch` | 无 | 跟随 `useSystemProxy`（默认 `false` → direct） |
  | skill-store / kit-store / mcp-marketplace | 主进程 Node `https.get` | 10s | **不走代理**（`main.ts` 只对 `defaultSession` 调 `setProxy`，Node 无 global-agent） |
  | login-url | `session.defaultSession.fetch`（经渲染进程 `api:fetch`） | 无 | 同上 |

- **`https.get` 那三个只支持 HTTPS 且校验证书**，自签证书会直接失败；要求 HTTP 200，
  非 200 抛 `HTTP <status>`。
- **`login-url` 必须带 `Content-Type: application/json`**：`main.ts:13208-13219` 按
  content-type 决定是否 `response.json()`，不是 JSON 类型时 `data` 是字符串，
  `typeof data === 'object'` 判断失败 → 静默回退到 portal 登录页（内网不可达）。

### 1. 自动更新

- 自动检查：`GET https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/{test,prod}/update`
- 手动检查：`…/update-manual`（设置页点「检查更新」）
- 请求头：仅 `Accept: application/json`（`appUpdateCoordinator.ts:619-624`）。
- 查询串由 `getUpdateQueryString` 生成（`:740-756`），顺序即下表：

  | 参数 | 来源 | 是否必现 |
  | --- | --- | --- |
  | `uuid` | 安装 ID，SQLite `installation_uuid`，无则随机生成并落库 | 有值才带 |
  | `userId` | `authUser?.yid` | 有值才带 |
  | `version` | `app.getVersion()`，可用 `LOBSTERAI_UPDATE_CURRENT_VERSION` 覆盖 | 有值才带 |
  | `firstKeyfrom` | 首次归因渠道，默认 `official` | **必带** |
  | `latestKeyfrom` | 最近归因渠道 | **必带** |

  注意**没有** os / arch / channel 参数，平台分支全在客户端本地判断。

- 响应（`UpdateApiResponse`，`appUpdateCoordinator.ts:49-64`）：

  ```json
  {
    "code": 0,
    "data": {
      "value": {
        "version": "2026.9.10",
        "date": "2026-09-10",
        "changeLog": {
          "ch": { "title": "更新内容", "content": ["修复 A", "新增 B"] },
          "en": { "title": "What's new", "content": ["Fix A", "Add B"] }
        },
        "macIntel":   { "url": "https://.../x64.dmg" },
        "macArm":     { "url": "https://.../arm64.dmg" },
        "windowsX64": { "url": "https://.../setup.exe" }
      }
    }
  }
  ```

  | 字段 | 类型 | 缺省行为 |
  | --- | --- | --- |
  | `code` | number | 非 `0` → 报错 `Update check failed with code <code>` |
  | `data.value.version` | string | 非字符串或 trim 后为空 → **视为无更新**（不是错误） |
  | `data.value.date` | string | 缺省 `''` |
  | `changeLog.ch.title` | string | 非字符串 → `''` |
  | `changeLog.ch.content` | string[] | 非数组 → `[]` |
  | `changeLog.en.*` | 同上 | 同上 |
  | `macArm` / `macIntel` / `windowsX64` `.url` | string | 见下 |

  **注意 key 名不一致**：接口是 `changeLog.ch`，内部结构是 `changeLog.zh`。

- 语义：`version` 必须**严格大于**当前版本才算有更新（本地做语义化比较），
  否则返回 `null`（无更新，非错误）。所以「没有新版本」应返回 `code: 0` +
  空 value 或当前版本号，**不要**返回非 0 错误码。

- 下载地址选择（`getPlatformDownloadUrl`，`:664-692`）：

  | 平台 | 取值字段 |
  | --- | --- |
  | macOS arm64 | `macArm.url`，空则兜底 |
  | macOS x64 | `macIntel.url`，空则兜底 |
  | Windows | `windowsX64.url`，空则兜底 |
  | Linux / 其他 | 一律兜底 |

  兜底地址是 `https://lobsterai.youdao.com/#/download-list`（`endpoints.ts:67-71`），
  属「落地页」而非安装包，客户端只能唤起浏览器打开。

- **Windows 安装包 URL 有硬校验**（`appUpdateUrlPolicy.ts:39-68`），不满足直接抛错、
  **不降级到兜底**：必须 `https:`、路径以 `.exe` 结尾、无 userinfo、无 `#fragment`、
  **不能带端口**（显式 `:443` 会被 WHATWG 归一化掉，所以可以用默认端口）。
  错误码统一为 `update-url-untrusted`。
- macOS 无该校验，但**要能预下载则路径必须以 `.dmg` 结尾**；否则只唤起浏览器。
- 失败行为：非 2xx / `code!==0` / JSON 解析失败 / 网络异常，都写进 `error` 字段并降级为
  `Error`（若已有更新信息）或 `Idle`；已下载完成并校验过的安装包会被保留。
- 重试：**接口本身无超时、无重试**。由渲染进程心跳驱动（启动时、每 30 分钟、
  窗口可见、网络恢复），且两次检查间隔不小于 2 小时。

### 2. Skill 商店

- `GET …/lobsterai/{test,prod}/skill-store`，无参数、无请求头。
- 主进程 `ipcHandlers/skills/handlers.ts:160-193` 只做透传，**原样返回字符串**，
  解析在渲染进程 `src/renderer/services/skill.ts:400-441`。

  ```json
  {
    "code": 0,
    "data": {
      "value": {
        "localSkill": [
          { "id": "web-search", "name": "web-search", "description": "联网搜索",
            "version": "1.0.0", "displayName": "联网搜索", "icon": "https://..." }
        ],
        "marketplace": [
          { "id": "slack", "name": "slack",
            "description": { "en": "Slack integration", "zh": "Slack 集成" },
            "tags": ["im"], "url": "https://.../slack.zip", "version": "1.2.0",
            "source": { "from": "Github", "url": "https://github.com/...", "author": "x" },
            "displayName": "Slack", "icon": "https://...", "downloadCount": 120 }
        ],
        "marketTags": [ { "id": "im", "en": "IM", "zh": "即时通讯" } ]
      }
    }
  }
  ```

  | 字段 | 类型 | 必填 |
  | --- | --- | --- |
  | `value.localSkill[]` | 数组，缺省 `[]` | 否 |
  | └ `id` / `name` / `description` | string \| `{en,zh}` | 是 |
  | └ `version` | string | 是（用于本地描述索引） |
  | └ `displayName` / `icon` | 可选 | 否 |
  | `value.marketplace[]` | 数组，缺省 `[]` | 否 |
  | └ `id` / `name` / `url` / `version` | string | **是** |
  | └ `description` | string \| `{en,zh}` | 是 |
  | └ `tags` | string[] | 否 |
  | └ `source.{from,url,author}` | string | `from`/`url` 是；`source.url` 仅用于
    `shell.openExternal` 外链 |
  | └ `displayName` / `icon` / `downloadCount` | 可选 | 否 |
  | `value.marketTags[]` | `{id,en,zh}` | 否，缺省 `[]` |

- **二次请求（内网也要放通）**：`marketplace[].url` 是 `.zip` 包地址，安装/升级时由
  主进程直接下载（`skillManager.ts:2178-2181`，同时支持 git 源）。
  即商店接口只给元数据，真正的包体走另一个 URL。
- 降级：任一环节失败 → 返回空列表并 `console.error`，UI 显示空商店，不阻塞。

### 3. Kit 商店

- `GET …/lobsterai/{test,prod}/kit-store`，无参数、无请求头。
- **主进程会改写响应**：`skinPackKitLifecycle.appendToStoreResponse`
  （`src/main/skins/skinPackKitLifecycle.ts:64-98`）把内置 Kit（皮肤包、以及
  平台支持时的 Computer Use）**追加**进 `value.kits` 并做 id 去重。所以内网服务
  返回的 `kits` 会被合并，不是最终结果。

  ```json
  {
    "code": 0,
    "data": {
      "value": {
        "kits": [
          {
            "id": "acme-kit",
            "name": { "en": "Acme Kit", "zh": "Acme 套件" },
            "description": { "en": "...", "zh": "..." },
            "icon": "https://...", "author": "acme", "version": "1.0.0",
            "workflowKind": "skin",
            "downloadCount": "120",
            "tryAsking": ["帮我用 Acme 做...", "..."],
            "skills": {
              "bundle": "https://.../acme-kit.zip",
              "list": [ { "id": "acme-a", "name": "A", "description": "..." } ]
            },
            "mcpServers": null,
            "connectors": null
          }
        ]
      }
    }
  }
  ```

  | 字段 | 类型 | 必填 |
  | --- | --- | --- |
  | `value.kits[]` | 数组 | 是（缺失 → 前端解析为空商店） |
  | └ `id` / `name` / `description` | string \| `{en,zh}` | 是 |
  | └ `skills.bundle` | string（zip 地址） | **安装必需**，缺失则 `Kit has no skill bundle URL` |
  | └ `skills.list[]` | `{id,name,description?}` | 是 |
  | └ `icon` / `author` / `version` / `workflowKind` / `tryAsking` / `downloadCount` | 可选 | 否 |
  | └ `mcpServers` / `connectors` | 数组或 null | 否 |

- **二次请求**：`skills.bundle` 作为 `bundleUrl` 传给 `kits:install`，主进程
  `downloadBuffer(bundleUrl)` 拉 zip（`ipcHandlers/kits/handlers.ts:294`）。
- 降级：**kit-store 是唯一有离线兜底的接口** —— 拉取失败时返回
  `buildOfflineStoreResponse()`（只有内置 Kit 的合法响应）并带 `warning` 字段。
  若响应缺 `data.value`，`appendToStoreResponse` 原样返回未改写的字符串。

### 4. MCP 市场

- `GET https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/{test,prod}/mcp-marketplace`
- **注意选路方式不同**：这里用 `app.isPackaged` 判断（打包 → `prod`，未打包 → `test`），
  不是 `testMode`（`ipcHandlers/mcp/handlers.ts:347-349`）。
- 缺 `data.value` 直接报 `Invalid response: missing data.value`。

  ```json
  {
    "code": 0,
    "data": {
      "value": {
        "servers": [
          { "id": "filesystem", "name": "Filesystem", "name_zh": "文件系统",
            "icon": "https://...", "description_zh": "...", "description_en": "...",
            "category": "developer", "transportType": "stdio",
            "command": "npx", "defaultArgs": ["-y", "@modelcontextprotocol/server-filesystem"],
            "requiredEnvKeys": [], "optionalEnvKeys": [], "kind": "..." }
        ],
        "categories": [ { "id": "developer", "name_zh": "开发者", "name_en": "Developer" } ]
      }
    }
  }
  ```

  | 字段 | 类型 | 必填 |
  | --- | --- | --- |
  | `value.servers[]` | `McpMarketplaceServer[]` | 是 |
  | └ `id` / `name` / `category` / `transportType` / `command` | string | 是 |
  | └ `defaultArgs` | string[] | 是 |
  | └ `name_zh` / `icon` / `description_zh` / `description_en` / `requiredEnvKeys` / `optionalEnvKeys` / `kind` | 可选 | 否 |
  | `value.categories[]` | `McpMarketplaceCategoryInfo[]` `{id,name_zh,name_en}` | 是 |

- 渲染进程会把结果落到本地缓存，失败时用 `getCachedMarketplace()` 兜底。
- 这个接口只提供 MCP 的**元数据与命令行**，不下载包体；真正拉包走 npm/npx，
  内网需要另行配置 registry。

### 5. 登录地址

- `GET …/lobsterai/{test,prod}/login-url`，请求头 `Accept: application/json`
  （`src/renderer/services/auth.ts:501-518`）。
- 响应：`{ "code": 0, "data": { "value": "https://lobsterai.youdao.com/portal#/login?..." } }`
  —— `value` 是要用系统浏览器打开的**完整 URL 字符串**（非空、trim 后有效即可）。
- 失败或格式不符 → 回退 `https://lobsterai.youdao.com/portal#/login`。
  内网环境该地址不可达，**这个接口必须实现**，否则用户点登录无反应。
- 内网登录开关 `INTRANET_CREDENTIAL_LOGIN_ENABLED = true` 时**不再请求本接口**，
  整体被工号密码登录取代（见上文「修改登录」）。

### 6. 内网接入方式

- 五个接口都**没有环境变量、没有配置项**可改地址；只有 `testMode` 决定 `test`/`prod`
  路径段。要指向内网，只有两条路：
  1. 改 `src/main/libs/endpoints.ts` 与 `src/renderer/services/endpoints.ts` 里的常量
     （推荐，随构建走，可 grep 到全部改动）；
  2. DNS / hosts 把 `api-overmind.youdao.com` 指到内网服务，并配受信任证书
     （`https.get` 那三个接口不认自签证书，需把 CA 装进系统信任链）。
- 也可以直接**关掉功能**：更新检查可用 `enterprise_config.disableUpdate = true`
  短路（`appUpdateCoordinator.ts:152-156`）；商店类失败会自然降级为空列表，
  但会有 10s 超时和报错日志。

### 7. 待确认

- 上述字段名与类型是从**客户端读取侧**反推的（`appUpdateCoordinator.ts`、
  `services/skill.ts`、`services/kit.ts`、`services/mcp.ts`、`services/auth.ts`），
  不是服务端文档。内网实现按此返回即可被消费，但服务端真实契约（尤其
  `source`、`workflowKind`、`kind` 的取值域）需与后端核对。
- 上线前建议抓一次真实响应做对照，重点核对 `changeLog.ch` 的 key 名和
  Kit 的 `skills.bundle` 是否为绝对 URL。

## 主服务端接口字段明细（内网实现用）

主服务端（`lobsterai-server[.inner].youdao.com`）这批与 overmind 那批的差别：
**全部带鉴权**（`fetchWithAuth`），信封是 `{ code, message, data }`，`data` 常直接是数组/对象，
**不像 overmind 那样再包一层 `value`**，且没有 `login-url` 那种 content-type 陷阱。本节逐个记录。

### 1. `/api/models/available` —— 套餐模型目录 + 运行能力声明

一句话：这是「套餐里能用哪些模型、每个模型支持什么」的**唯一来源**，客户端没有本地兜底模型表。

#### 调用方与时机

| 入口 | 位置 | 触发时机 |
| --- | --- | --- |
| `auth:getModels` IPC | handler `src/main/main.ts:7600`；实现 `loadAvailableServerModels`（`src/main/main.ts:5402`） | 渲染进程加载服务端模型时（`src/renderer/services/auth.ts:1058`） |
| 运行前 preflight 刷新 | `refreshServerModelsForRunPreflight`（`src/main/main.ts:5497`），由 `ensureServerModelReadyForRun`（`src/main/main.ts:5542`）调用 | **每次发起对话**前，若选中的服务端模型 ref 解析不出来 |
| 启动预取 | `src/main/libs/startupCacheWarmup.ts:89` | 已关（见上文 8. 本分支已关闭的入口） |

- 无 token 时（`src/main/main.ts:7604`）**不发请求**，直接返回 `{ success: false }`。
- preflight 那次是 `awaitConfigSync: true, forceConfigSync: true`：拿到响应后**必须**把模型写进
  OpenClaw 配置才继续起对话。

#### 请求

`GET {base}/api/models/available`，base 仍取 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts:31-49`）
—— **没有单独的环境变量覆盖**。

| 项 | 值 | 来源 |
| --- | --- | --- |
| Query | `firstKeyfrom`、`latestKeyfrom`、`uuid`、`userId`、`version` | `appendKeyfromQuery`（`src/main/main.ts:5284`）；空值不带；`uuid` 缺失时现场生成并落库 SQLite |
| Header `Accept` | `application/json` | `buildServerModelCapabilityHeaders`（`src/main/libs/startupCacheWarmup.ts:34`） |
| Header `X-LobsterAI-Client-Capabilities` | `kimi-k3-agentic-v1,thinking-level-control-v1` | `src/shared/providers/modelRuntimeProfiles.ts:17-25` |
| Header `X-LobsterAI-Client-Version` | `app.getVersion()` | 同上 |
| 鉴权 | `Authorization: Bearer <accessToken>`，401 自动刷新后重放 | `fetchWithAuth`（`src/main/main.ts:5367`） |
| 超时 | **无**（只有已关闭的 warmup 路径设了 5s） | |

能力头是**声明式**的：服务端可据此只返回该客户端能跑的模型；客户端**不会**因为服务端返回了
声明之外的模型而报错。内网可以忽略这两个头（返回全集），但要满足「声明了什么就得给对应字段」：
`thinking-level-control-v1` ↔ `thinkingConfig`；`kimi-k3-agentic-v1` ↔
`runtimeProfile: "moonshot-kimi-k3"` + `supportsToolCalling` + `agenticReady`（见下）。

#### 响应信封

```json
{
  "code": 0,
  "message": "…",
  "data": [
    { "modelId": "…", "modelName": "…", "provider": "…", "apiFormat": "openai" }
  ]
}
```

- **`data` 直接就是模型数组**（不是 `data.value`）。
- `code` 必须严格为数字 `0`，否则抛错并取 `message` 作错误文案（`src/main/main.ts:5440`）。
- `data` 非数组 → `Server model response is invalid.`
- HTTP 非 2xx → `Server model request failed with HTTP <status>.`（`src/main/main.ts:5417`）
- 响应体里 `code = 41602`（`EnterpriseApiErrorCode.NotMember`）→ 触发企业成员吊销 + 登出；
  `code = 41612`（`AccountModeMismatch`）→ 清 token 回未登录态（`src/main/main.ts:5436` → `:5148`）。
  内网若不跑企业版，**不要**用这两个码，普通失败用别的非 0 码即可。

#### 模型条目字段

类型定义：`AvailableServerModel`（`src/main/main.ts:5390`）=
`ServerModelMetadataInput`（`src/main/libs/claudeSettings.ts:93`）+ 显示字段。

| 字段 | 类型 | 必填 | 缺省 / 非法时的行为 |
| --- | --- | --- | --- |
| `modelId` | string | **是** | 唯一键（缓存、OpenClaw 配置、模型 ref 都用它）。trim 后为空 → **该条目被静默丢弃** |
| `modelName` | string | 是 | 仅显示；OpenClaw 配置里缺省回退到 `modelId` |
| `provider` | string | 是 | 显示 + 两个特判：`moonshot`（Kimi K3 候选识别）、`explicitContextCache` 的 provider 后缀匹配 |
| `apiFormat` | string | 是 | 只区分 `openai` / `anthropic`；**其它值一律当 `openai`**（`openclawConfigSync.ts:1602`） |
| `runtimeProfile` | string | 否 | 目前只认 `moonshot-kimi-k3`（`modelRuntimeProfiles.ts:100`）。非法值 → warn，且**该模型被 run gate 拒绝** |
| `supportsImage` / `supportsVideo` / `supportsThinking` | boolean | 否 | 缺省 false；**有 `runtimeProfile` 时被 profile 覆盖** |
| `contextWindow` / `maxTokens` | number | 否 | 同上，会被 profile 覆盖 |
| `thinkingConfig` | object | 否 | 仅在 `supportsThinking === true` 时解析；解析失败等同于没返回 |
| `requestCapabilities` | string[] | 否 | 白名单，目前只认 `lobsterai-options-v1`（`src/shared/providers/lobsterAIRequestOptions.ts:1`） |
| `supportsToolCalling` | boolean | 否 | 读原值。**有 `runtimeProfile` 时必须为 `true`**，否则该模型跑不了 |
| `agenticReady` | boolean | 否 | 同上，必须为 `true` |
| `explicitContextCache` | boolean | 否 | 缺省 false；true 时给该模型写 OpenClaw 显式缓存默认参数 |
| `costMultiplier` | number | 否 | 仅 `> 0` 生效；显示为 `x1.6` 徽标（`ModelSelector.tsx:973`）。疑似「积分消耗倍率」 |
| `description` | string | 否 | 直接显示，无 i18n |
| `moreModel` | boolean | 否 | `true` → 收进「更多模型」分组，默认折叠（`ModelSelector.tsx:97-98`） |
| `accessible` | boolean | 否 | 缺省 `true`；`false` → 可见但**置灰加锁、不可选**（`ModelSelector.tsx:938`） |
| `restrictionHint` | string | 否 | **当前是死字段**：一路透传到渲染层（`auth.ts:275`）但没有任何组件渲染它。想展示置灰原因得改 UI |

`thinkingConfig` 结构（`src/shared/providers/modelThinking.ts:59`）：

```json
{ "options": [ { "level": "medium", "openclawLevel": "medium" } ], "defaultLevel": "medium" }
```

- `level` ∈ `off|minimal|low|medium|high|xhigh|max`；
  `openclawLevel` ∈ `off|minimal|low|medium|high|xhigh`（**没有 `max`**）。
- **任何一个 option 非法 → 整个 `thinkingConfig` 判为无效并丢弃**（不是跳过那项）。
  内网要么给全套合法值，要么整段不返回。
- 另需满足：level 之间不重复、openclawLevel 之间不重复、`off` 必须成对出现、
  `defaultLevel` 必须出现在 `options` 里。只有 `[{ "level": "off" }]` 一个选项也算无效。

`runtimeProfile = "moonshot-kimi-k3"` 时客户端会**强制覆盖**这些字段
（`modelRuntimeProfiles.ts:35-56`、`:77`）：`supportsImage=true`、`supportsVideo=true`、
`supportsThinking=true`、`contextWindow=1048576`、`maxTokens=8192`，推理档位全部映射到 `max`。
内网不需要 Kimi K3 特化的话，**整个字段不返回**即可。

#### 拿到响应之后客户端做什么

1. `updateServerModelMetadata`（`claudeSettings.ts:224`）按 `modelId` **全量重建**缓存
   （不是增量合并，少返回的模型会消失）。
2. 与上次缓存做序列化比对（`serializeServerModelMetadata`，`claudeSettings.ts:180`）：
   只有内容变化、或 OpenClaw 配置里缺这些模型时才重写配置（`src/main/main.ts:5452`），否则跳过。
3. 把模型写成 OpenClaw provider `lobsterai-server` 下的模型列表
   （`openclawConfigSync.ts:2221-2280`），baseURL 固定 `http://127.0.0.1:<本地代理端口>/v1`，
   apiType 由 `apiFormat` 决定。**推理仍走 `/api/proxy/v1/*`** —— 这个接口只给目录，不代表联通。
4. 渲染进程 `mapAvailableServerModelsToModels`（`src/renderer/services/auth.ts:245`）转成 UI 模型列表。
5. 发起对话时再过一道 run gate（`claudeSettings.ts:328`）：无 metadata → 「模型信息不可用」；
   `runtimeProfile` 存在但不是 kimi-k3 → 拒绝；有 `runtimeProfile` 时要求 `apiFormat === 'openai'`、
   `supportsToolCalling === true`、`agenticReady === true`。
   **没有 `runtimeProfile` 的模型一律放行**（例外：`provider = moonshot` 且 `modelName` 归一化后为
   `kimik3` 的按 K3 严格要求）。

**硬失败**：模型列表里只要有 `runtimeProfile = moonshot-kimi-k3` 而 `apiFormat ≠ openai` 的条目，
**整个 OpenClaw 配置同步直接失败**（`openclawConfigSync.ts:2054-2063`），不是降级警告。
内网返回 K3 模型时必须给 `apiFormat: "openai"`。

#### 降级与重试

- 渲染进程对失败有 1s / 3s / 8s 三次重试（`src/renderer/services/auth.ts:285`、`:1012`），
  全部失败后**本次会话不再重试**，服务端模型分组保持为空。
- 失败不阻塞其它功能：用户自配模型（BYOK）不受影响（`modelSlice.ts:181` 只替换 `isServerModel` 那部分）。
- 响应回来时账号已切换/登出 → 结果被丢弃（`src/main/main.ts:5434`、`auth.ts:1056`）。
- **`data: []` 是合法响应**，客户端不报错，表现为「没有套餐模型可选」。

#### 内网实现要点

- 最小可用条目：`{ modelId, modelName, provider, apiFormat }`；想让它真能跑，再加
  `supportsToolCalling: true`、`agenticReady: true`。
- 五个 keyfrom query 参数可直接忽略，但**请求会带 `Authorization`**，鉴权必须做。
- 这份列表**同时决定**三件事：OpenClaw 配置里写哪些模型、UI 里能选哪些模型、
  选中后能不能起对话。改动它 = 改动这三个地方。

### 2. 待补

同一格式继续补 `/api/user/quota`、`/api/proxy/v1/*`。
