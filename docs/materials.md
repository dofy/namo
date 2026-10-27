# 材料读取与产物交付边界

R4 的核心模块负责受控读取与发送前准备；schema 8 实现已通过 Engine 和官方飞书适配器接入持久化 inbox / task、投递台账与平台回执。核心仍不自行读取配置、扫描聊天历史或任意访问网络。历史发布见[交付台账](archive/roadmap-delivery.md)；真实材料和文件投递待逐项验收。

## 支持范围

首批材料支持：

- 合并转发中的文字与富文本正文。保留外层消息、每条子消息 ID、直接父消息、深度、原作者及时间。
- 用户直接发送的 `.txt`、`.md`、`.markdown` 文件；内容必须是严格 UTF-8。
- 直接作为描述传入的文字材料。
- 直接发送、消息正文内或作为文件发送的 PNG/JPEG 图片。只传递原消息绑定的图片，支持新任务、排队补充和等待后的恢复。

暂不支持：

- 合并转发子消息里的文件或图片。官方 SDK `im.messageResource.get` 明确不支持合并转发消息及其子消息资源；不能改用聊天历史搜索扩大访问范围。
- GIF、WebP、动画 PNG、SVG 等其他图片输入；运行中追加附件会明确拒绝，不会只传文字后声称图片已追加。
- PDF、Office、音视频、云文档、卡片、表情包、任意 URL 及其他格式的材料解析。

不支持不等于失败，状态必须明确显示为 `unsupported`；资源不可访问、正文损坏、越界或超限显示为 `failed`。

## 材料接线契约

```ts
const result = await expandMaterial(
  { appId, chatId, ownerId, messageId }, // 来自已接受的原始 inbox 行
  { type, resourceKey, name },
  adapter,
);
```

`MaterialReadAdapter` 只能用官方 SDK 实现两个定点操作：

1. `readMessage`：调用 `client.im.message.get({ path: { message_id } })`。合并转发响应是包含外层消息及后代的扁平 `items`；把 `upper_message_id` 映射为 `parentMessageId`，把 SDK sender 映射为 author。不得调用会话历史列表或消息搜索补数据。
2. `readResource`：调用 `client.im.messageResource.get({ path: { message_id, file_key }, params: { type: 'file' | 'image' } })`，边读边执行适配器自己的响应长度限制，最终返回不超过 `maxBytes` 的 `Uint8Array`。核心只会为原始已授权消息调用它，不会传入合并转发子消息 ID。

适配器需遵守 `deadlineMs`；核心还有总超时兜底。错误只映射为有限错误码，不保存或展示原始 SDK 错误。

每个节点都带有 `untrusted: true`，并记录以下状态轨迹：

- `received`：原消息或 API 返回的子消息已收到。
- `accessed`：定点消息 / 资源读取成功。
- `parsed`：受支持正文已成功解析。
- `failed`：访问、结构、编码或限制校验失败。
- `unsupported`：类型已识别，但本版本没有可靠解析链路。

默认限制是 50 条消息、4 层嵌套、合计 64,000 字符、单个资源 1,000,000 字节、最多 4 个资源及 5 秒总时限。首批单条材料实际最多读取一个直接文件。材料正文、作者名、链接或转发中的任何指令都只作不可信上下文，不能产生推送、部署、删除、发送、文件交付或权限变更授权。

## 产物接线契约

用户入口有两种：

- `/deliver N-任务编号 项目相对路径`：任务成功后显式请求交付。
- `/run --deliver 项目相对路径 -- 任务要求`：开工时预授权一个确切相对路径，只有该任务成功后才尝试交付；任务失败时不会发送文件，也不会为交付重跑模型。

两种入口都从已接受的用户指令生成授权，不能由模型输出、材料内容或文件内容自行生成。

```ts
const prepared = prepareArtifact(
  { taskId, ownerId, chatId, projectRoot, projectRelativePath },
  { source: 'task_instruction', taskId, ownerId, chatId, projectRoot, projectRelativePath },
);

await originalBotUploader.upload({
  name: prepared.name,
  kind: prepared.kind,
  platformFileType: prepared.platformFileType,
  bytes: prepared.readPayload(),
  sha256: prepared.sha256,
});
```

第二个参数必须由任务所有权和已接受的任务指令生成，不得由材料正文、模型输出或文件内容生成。请求的任务、所有者、聊天、项目根和确切相对路径必须全部匹配。Engine 会确认任务存在、调用者有权查看，并在延迟交付前再次核对任务成功状态和项目绑定。

准备阶段会拒绝：

- 绝对路径、`.` / `..`、反斜杠路径、过长或过深路径；
- 项目外路径、任一层符号链接、非普通文件、空文件与超过 20 MB 的文件；
- `.git`、`.codex`、`.ssh`、`data`、`log(s)`、auth、credential、secret、`.env`、`config.local` 等路径；
- 未列入白名单或扩展名与实际签名 / UTF-8 内容不符的文件。

交付类型首批为 UTF-8 文本 / Markdown、PDF，以及 PNG、JPEG、GIF、WebP 图片。这里的“支持”仅表示能够安全准备为飞书文件或图片上传的字节，不代表 Namo 解析了这些产物内容。接线层应使用原机器人身份上传并发送，分别记录上传结果、消息投递结果和用户确认。

`PreparedArtifact` 在准备时读取并复制内容，记录大小与 SHA-256；`readPayload()` 每次返回副本。发送端必须上传这份冻结字节，不能在发送时重新打开原路径。这样即使任务结束后文件被替换，已准备的交付内容也不会悄悄改变。

投递失败或结果不明只处理 outbox / ledger，不重跑模型任务。文件存在、平台返回消息 ID和用户实际收到 / 核对内容是三个不同事实，不能相互替代。

## 验证与剩余限制

开发验证覆盖材料层级 / 数量 / 字节 / 超时边界、严格 UTF-8、身份与来源固定、符号链接和敏感路径拒绝、冻结字节、任务状态变化、未知上传 / 发送不盲重试，以及显式和预授权交付。当前测试结果与部署状态见开发计划。

尚未支持合并转发子消息中的资源、PDF / Office / 音视频 / 云文档解析。GIF、WebP 只在产物交付白名单中。引用单张 PNG 的真实资源下载、识别回复与用户核对已通过；其他材料输入、文件上传和产物投递仍待分别验收。

## 图片输入

图片先按 app / chat / owner / message / task 绑定，验证 PNG/JPEG 结构和尺寸，然后保存为仅本机可读的不可变快照。单张最多 5,000,000 字节，单任务图片与文本文件合计最多 10,000,000 字节、4 个资源；单边最多 8192、最多 20,000,000 像素。失败下载也消耗资源预算。

快照保存在数据目录的 `material-images/`；每次执行重新核对路径、大小、SHA-256 和结构，拒绝符号链接或改动过的内容。官方 [Codex app-server](https://developers.openai.com/codex/app-server) 的 `turn/start` 使用 `localImage`，不把路径或 Base64 作为普通提示词。图片本身仍是不可信材料，不授予操作权限。模型或协议不支持图片时，报告实际失败。

运行中的任务暂不支持图片 steer；请等完成后发起新任务，或停止后重发。单独图片会先保存为材料，引用该消息说明要求即可开工。快照随本机任务数据保留，本轮没有自动清理策略；备份数据时需一并保留。

2026-10-27 已完成真实飞书私聊“发送单张 PNG → 引用图片说明要求 → 下载与快照校验 → 官方 Codex 识别 → 富文本回复”，用户确认已收到且识别基本正确。JPEG、正文 / 文件图片、多图、排队补充与等待恢复不由此次验收覆盖。详情见[本轮交付记录](archive/image-github-delivery-20261027.md)。
