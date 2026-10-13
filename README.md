# dsh-todo-aitm-bridge

在 DSH 待办任务菜单中提供 “在 AI 任务台创建想法 / 开始工作” 的桥接插件。

- 待办侧扩展点：`window.__dshTodoTaskActions` v1（见 `vonvonyung/dsh-task-todo` 的 `docs/todo-aitm-bridge_design.md`）
- 不 import 待办或 AI 任务台的任何包；所有接缝都在运行时完成。
- 不导出、复制或绕过 AI 任务台的 `L3` 句柄。

## 当前实现状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 菜单 “在 AI 任务台创建想法”：保留原待办，`sourceRef` 关联，服务端按 `sourceRef` 幂等 | 客户端与测试已完成 |
| 2 | 开始工作：先展示解析后的项目/引擎/模型与指令，**明确确认 (`=== true`) 才调用启动**；取消、抛错、双击均不启动 | 流程与测试已完成 |
| 3 | agent 工具（需宿主级审批） | 未实现，按设计后置 |

### 目录

- `src/contract.js`：常量、`sourceRef`、待办 → 想法字段映射、幂等键、错误类型。
- `src/bridge-client.js`：浏览器侧客户端，只请求桥自己的同源相对路由 `/dsh-todo-aitm-bridge/api/*`。超时、协议版本不兼容、网络失败分别映射为明确状态。
- `src/start-flow.js`：创建 → 预览 → 确认 → 启动的流程，返回 `started / cancelled / partial / failed / busy`。
- `src/todo-menu.js`：待办 API 版本检查、两行菜单动作、就绪事件后的延迟注册、可释放的 disposer。
- `src/index.js`：浏览器入口 `installBridge(window)`。
- `test/`：38 项 `node:test` 测试。

### 运行测试

```sh
npm test   # node --test，无外部依赖
```

## 尚未具备的前提（阻塞端到端）

1. **DSH 宿主半边（服务端路由与插件清单）未实现。** 上面的 `/dsh-todo-aitm-bridge/api/*` 路由是本插件自己的 v1 契约，需由宿主半边实现；插件清单格式也需按 DSH 插件规范补齐，本仓库尚未确认。
2. **AI 任务台没有可用的受限、版本化插件接口。** 现状：
   - `/aitm-plugin/config` 是诊断性质的发现路由，返回随机 `base` 与诊断信息，不是承诺的 ABI；
   - `/api/<action>` 可调用全部 action，且返回 `Access-Control-Allow-Origin: *`；
   - `L3` 句柄对其他插件不可见，`createL3()` 只会新建第二个实例。

   因此本仓库**没有**通过这些途径访问 AI 任务台。
3. **AI 任务台需要提供的最小接口**（在 `ai-tasks-mgr` 仓库实现，不在本会话范围内）：
   - 版本化发现响应：`{ service, protocol, base, capabilities }`，不含仓库路径或日志；
   - `idea.create`：以 `sourceRef` 幂等，重复请求返回已有想法（`created:false`）；
   - `idea.start-preview`：只读返回解析后的项目、引擎、模型、指令与副作用；
   - `idea.start`：支持 `Idempotency-Key`，返回 `started` 与 `taskId`；
   - 认证方式、允许调用的动作白名单，以及 `AITM_URL` 的地址范围。

## 已知设计限制

- 开始工作时会先创建想法（步骤 1），再展示确认框。取消确认时想法已存在，结果会如实提示“想法已创建，未开始工作”。
- 确认框使用 `window.confirm`，仅适用于人工点击菜单的场景，**不能**作为 agent 调用的授权边界。没有原生对话框时默认拒绝。
- `due` 目前按原字符串透传，日期与时区语义尚未在契约中定义。
- v1 不做双向状态同步。
