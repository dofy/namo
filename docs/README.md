# Namo 文档

[English technical guide](technical-guide.md) · [简体中文技术指南](technical-guide-zh-cn.md) · [返回产品介绍](../README.zh-CN.md)

推荐通过[文档站](../docs-site/)按主题阅读：在项目根目录运行 `pnpm cli docs`，或使用已安装的 `namo docs`，即可启动本地服务并打开浏览器。按 Ctrl+C 停止服务。文档站提供中英文、章节导航和深浅色模式。以下 Markdown 文档保留更细的实现与运维参考。

| 文档 | 解决什么问题 |
| --- | --- |
| [技术指南（中英文）](technical-guide-zh-cn.md) | 安装、功能、权限、运行和开发 |
| [使用指南](getting-started.md) | 飞书接入、聊天命令、工作台 |
| [运维指南](operations.md) | 配置、权限、异常处理、升级、迁移 |
| [技术实现](architecture.md) | 整体链路、模块职责、关键约束 |
| [开发路线图](development-plan.md) | 已实现范围、验收缺口、下一步优先级 |

技术指南提供中英文版本；上述使用、运维、技术实现和路线图参考文档目前为中文。

历史方案和验收记录保留在 Git，精简前的快照为 `adc53b8`：

```sh
git ls-tree --name-only adc53b8:docs/archive
git show adc53b8:docs/archive/p0-live-delivery-20261027.md
```
