# Namo 文档

| 文档 | 解决什么问题 |
| --- | --- |
| [使用指南](getting-started.md) | 安装、飞书接入、聊天命令、工作台 |
| [运维指南](operations.md) | 配置、权限、异常处理、升级、迁移 |
| [技术实现](architecture.md) | 整体链路、模块职责、关键约束、开发命令 |
| [开发路线图](development-plan.md) | 已实现范围、验收缺口、下一步优先级 |

技术设计统一维护在一份文档；计划只记录状态和退出条件，不再追加逐次交付流水。

历史方案和验收记录保留在 Git，精简前的快照为 `adc53b8`：

```sh
git ls-tree --name-only adc53b8:docs/archive
git show adc53b8:docs/archive/p0-live-delivery-20261027.md
```
