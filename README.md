# dsh-todo-aitm-bridge

在 DSH 待办任务菜单中提供两个动作，把待办接到 AI 任务台：

- **在 AI 任务台创建想法**：保留原待办，建立 `sourceRef` 关联，按来源幂等。
- **在 AI 任务台开始工作**：先展示 AI 任务台解析出的项目、引擎、模型与指令，用户明确确认后才启动；取消或确认失败都不会启动。

## 架构

```
待办菜单 (window.__dshTodoTaskActions v1)
   │  dist/client.js  ── 浏览器半边，只请求同源 /dsh-todo-aitm-bridge/api/*
   ▼
宿主半边 src/host/*  ── 校验 DSH 会话 / Origin / 输入，固定 4 条路由
   │  ctx.get('aitmBridge')  （方式 A：ai-tasks-mgr 冻结的 Bridge v1 门面）
   ▼
AI 任务台  discovery · createIdea · previewStart · startWork
```

- 浏览器从不直接访问 AI 任务台，也不接触 bridge token、`L3`、`base` 或任意 action。
- 没有任何通用转发；宿主只有以下路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-todo-aitm-bridge/api/health` | 返回 `aitm.state`：`ready` / `unavailable` / `incompatible` |
| POST | `/dsh-todo-aitm-bridge/api/ideas` | 创建或复用想法（按 `sourceRef` 幂等） |
| POST | `/dsh-todo-aitm-bridge/api/ideas/:id/start-preview` | 只读预览，返回 `preview` 与 `previewDigest` |
| POST | `/dsh-todo-aitm-bridge/api/ideas/:id/start` | 启动；必须携带与预览一致的 `confirmedPreviewDigest` |

## 宿主端安全规则

- **会话**：通过 DSH 的 `connection.admit(req)` 校验；没有该服务或被拒绝时一律失败关闭（401/403）。
- **来源**：拒绝 `Sec-Fetch-Site: cross-site`、`Origin: null` 以及与 `Host` 不一致的 `Origin`。
- **输入**：`sourceRef.plugin` 固定为 `dsh-todo`，忽略浏览器传来的值；标题、备注、截止日期、标签均有长度与类型限制；请求体需为 `application/json`，上限 64 KB；想法 ID 必须是安全字符。
- **幂等键由宿主派生**，不接受浏览器的请求头：
  - 创建：`dsh-todo:<taskId>:idea`
  - 启动：`dsh-todo:<taskId>:start:<ideaId>`
- **确认绑定到配置**：启动前宿主重新预览，若与用户确认的摘要不一致，返回 409 `preview-changed`，不启动。启动请求中的 `instruction` 会被丢弃。
- **响应白名单**：只返回约定字段，不包含内部路径、AI 任务台版本或门面的 `base`。
- **超时**：每次调用门面有 15 秒超时，超时映射为 503。
- **错误映射**：只有 AI 任务台的用户可纠正错误（如 `conflict`、`blocked`、`no-repo`、`engine-not-ready`、`idempotency-conflict`）原样透出；其余（包括内部错误、未知码、网络错误）统一为 503 `aitm-unavailable`，消息为“AI 任务台当前不可用”。

## 依赖机制与降级

插件在 `apply(ctx)` 中**不**把 `aitmBridge` 声明为必需 `inject`，所有依赖都是可选的、懒取的：

| 依赖 | 缺失时的行为 |
| --- | --- |
| `aitmBridge`（ai-tasks-mgr 通过 `ctx.provide` 提供） | 每个请求重新 `ctx.get`；缺失或晚加载时，`health` 报 `unavailable`，业务路由 503。菜单行保留为灰色禁用项，并显示“AI 任务台当前不可用”。服务晚加载后，下一次探测即可恢复。 |
| `connection`（DSH 会话） | 所有路由 401，失败关闭 |
| `webServer` | 只记录警告，不注册路由（浏览器半边无法工作） |

门面检查：必须是 `protocol: 1`，具备 `discovery / createIdea / previewStart / startWork` 四个方法；`discovery` 返回的 `service` 必须是 `ai-tasks-mgr`，且 `capabilities` 包含 `idea.create`、`idea.start-preview`、`idea.start`。否则为 `incompatible`，不会把请求发给错误目标。

浏览器端的菜单状态变化会触发菜单刷新：同 ID 重新注册会替换旧记录，因此禁用项无需重新打开菜单即可更新。

## 目录

- `src/contract.js`：共享常量、`sourceRef`、待办 → 想法映射、幂等键。
- `src/host/index.js`：DSH 插件入口（`name`、`inject`、`apply`）。
- `src/host/http.js`：路由、会话与来源校验、输入校验、错误映射。
- `src/host/aitm.js`：门面适配（就绪检查、超时、错误映射、预览视图与摘要）。
- `src/bridge-client.js`：浏览器侧客户端与状态机。
- `src/start-flow.js`：创建 → 预览 → 确认 → 启动流程。
- `src/todo-menu.js`：待办 API 版本检查、菜单行注册与刷新。
- `src/index.js`、`src/client-entry.js`：浏览器入口；构建为 `dist/client.js`。
- `cordis.patch.yml`：DSH bundle patch；`package.json` 的 `dsh` 字段声明 web 客户端。

## 开发

```sh
npm install
npm test     # pretest 先构建 dist/client.js，然后运行 node --test
npm run build
```

`dist/client.js` 已提交，DSH 安装时无需构建。

## 依赖版本

- AI 任务台：`ai-tasks-mgr` 提交 `0bfef98`（v0.3.48，Bridge v1）。
- 本插件仅用 Node 内置模块；`esbuild` 只作为开发依赖，用于打包浏览器半边。

## 未验证与限制

- **未在真实 DSH 中加载验证。** 本环境没有运行 DSH 宿主。依赖的 DSH 接口（`ctx.get`、`ctx.effect`、`webServer.register` 的 `prefix` 语义、`connection.admit`、`window.__ModuleLoader__.load`）均参照 ai-tasks-mgr 与 dsh-task-todo 现有代码的用法，尚未实测。
- **未与真实 AI 任务台端到端联调。** 测试使用按门面契约模拟的假门面。
- 启动流程中，“创建想法”发生在确认框之前；取消后想法仍然存在，提示会如实说明。
- 确认框使用 `window.confirm`，仅适用于人工点击菜单的场景，**不是** agent 的授权边界。没有原生对话框时默认拒绝。
- `due` 按原字符串透传，日期与时区语义尚未在契约中定义。
- v1 不做双向状态同步；agent 工具仍后置，并需宿主侧审批。
