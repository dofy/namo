# 未来 Agent 插件扩展预留

2026-10-27：当前产品只接入官方 Codex。Claude SDK、实验 worker、Claude / Cursor 探测、Agent 注册配置和切换入口已移除。未来可通过插件接入其他 Agent，但本阶段不实现插件功能。

保留 `src/runtime-contract.ts` 的 `Runtime`、`RunRequest`、`RunResult` 和事件接口作为内部边界；接口仍可随 Codex 主线需求调整，不承诺公共插件 API 稳定性。`src/agents.ts` 的执行工厂仅创建 Codex runtime。

未来插件必须满足以下要求：

- Namo 负责持久入站、授权、任务状态、项目锁、全局并发、等待恢复、记忆范围和飞书投递，插件只负责执行及报告结果。
- 独立的认证与状态目录；不自动继承宿主凭据、hooks 或扩大工具权限。
- 原生会话不得跨执行器复用；任务已开始后，不自动改派或重放执行结果不明的请求。
- 进度、证据、取消、等待与恢复分别验收，不以安装成功或握手成功代替功能验收。
- 仅在明确需要第二执行器时设计插件安装与加载；当前不引入额外 SDK、公共插件 SDK、动态加载器、路由规则或插件市场。

[旧 Codex 配置兼容](agent-registry.md)只用于保留已有任务、隔离目录和会话标识，不构成多执行器功能。之前的[兼容性研究](archive/agent-compatibility.md)及[Claude 实验](archive/claude-adapter.md)仅作历史记录。
