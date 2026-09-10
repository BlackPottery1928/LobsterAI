## 精简设置页面
## 修改登录

内网构建改用内网权限接口登录（工号 + OA 密码），不再走「系统浏览器门户 + 回环回调」链路。

### 合并上游主干前的还原办法

`grep -rn "INTRA-ONLY" src` 就是完整清单 —— 该功能在上游文件里的每一个 hunk 都带这个标记。

**第一步：删掉这些新增文件/目录（删干净即可，无残留引用）**

- `src/shared/intranetAuth/`
- `src/main/libs/intranetAuthLogin.ts` 及其 `intranetAuthLogin.test.ts`
- `src/main/ipcHandlers/intranetAuth/`
- `src/renderer/services/intranetCredentialLogin.ts`
- `src/renderer/components/auth/`

**第二步：还原下列上游文件的改动**

| 文件 | 改动 |
| --- | --- |
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
段落：登录路径、请求/响应字段名、超时。base URL 默认走 `getServerApiBaseUrl()`，
可用环境变量 `LOBSTER_INTRANET_AUTH_BASE_URL` 覆盖。真实接口文档到位后只改这一段。

### 已知边界

登录后 `fetchWithAuth` 的下游请求（`/api/user/profile`、`/api/user/quota`、模型列表、
token 刷新、代理）仍指向现有 `getServerApiBaseUrl()`。凭证登录路径刻意**不**主动调用
它们（否则 401 会触发 `AuthSessionManager` 的 terminal refresh，把刚建立的会话清掉），
但窗口聚焦的配额检查与下次启动的 `authService.init()` 仍会请求。若内网 token 不被现有
服务端接受，会出现「登录成功、聚焦窗口或重启后被登出」。

## 修改积分提示
## 修改对话模型
