# Namo 文档索引

首次使用从安装指南开始；功能文档描述源码契约，历史记录只证明对应批次的验收。服务当前版本须由本机状态核对，不能从文档推断。

## 安装与使用

- [项目介绍（中文）](../README.zh-CN.md) · [English](../README.md)
- [安装与第一次使用](getting-started.md)：初始化、配对、工作台与本人档案。
- [飞书日常回复](chat-experience.md)：表情、正文格式、阶段进度及展示限制。
- [助手设置与档案使用](assistant-settings.md)：启用条件、语言优先级、版本与生效范围。
- [材料读取与产物交付](materials.md)：支持的类型、读取限制与文件交付。
- [长期记忆与交接](memory.md)：显式保存、查询、纠正、停用及删除。

## 运维与迁移

- [配置与运维](operations.md)：诊断、配置、异常核对与恢复。
- [发布与开发隔离](release-isolation.md)：固定快照、升级门禁与版本核对。
- [OpenClaw 迁移](openclaw-migration.md)：来源检查、导入、人工切换和回退。

## 开发与功能契约

- [开发指南](development.md)：构建、前端开发、验证与包检查。
- [架构](architecture.md)：消息、任务、工作线、调度与权限。
- [独立运行进程](runner.md) · [等待用户回复](waits.md) · [GitHub 检查等待](external-waits.md)
- [执行证据](result-evidence.md) · [受控 Git push](approvals.md)
- [后续计划与验收缺口](development-plan.md)
- [首次反馈与执行过程卡片计划](progress-feedback-plan.md)：首卡提速、公开进展和工具摘要已升级本机服务；图片预览与流式更新留后续。
- [多执行器接入与任务路由计划](agent-adapters-plan.md)：Claude / Cursor 接入、能力差异、切换和交接的分期计划。
- [执行器注册表](agent-registry.md) · [兼容性验证基线](agent-compatibility.md)：R7.1 配置和安全边界、R7.0 的实测证据与缺口。
- [品牌资源](brand.md) · [字体与许可证](../assets/fonts/README.md)

## 历史记录

- [M1 验收](archive/m1-verification.md)
- [M2 分批验收](archive/m2-verification.md)
- [R7 注册表隔离验证](archive/r7-registry-verification-20261027.md)
- [R0–R6 交付台账](archive/roadmap-delivery.md)
- [发布历史补充](archive/release-history.md)

## 维护约定

每个主题只在对应功能文档维护完整契约；README 和架构文档保留摘要与链接。计划只记录未完成项、验收条件和后续候选。已完成的测试数量、发布标识及本机切换记录归档，不在多处维护“当前在线版本”。

实现、隔离测试、真实模型验证、部署、平台接受和用户收件分别记录。历史未覆盖项不自动视为当前缺陷，新增实现也不自动视为真实客户端验收通过。移动文件时同步修改链接和锚点。
