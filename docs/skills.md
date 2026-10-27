# Skills access

Namo discovers skills through the official Codex app-server before starting a normal task. It grants read-only access to each enabled skill's canonical directory, including its scripts and reference files. Symlinked skill directories are resolved individually; neither the user home, `.agents`, `.codex`, nor a plugin cache parent is opened.

Only `skills.config` preferences are read from the personal `~/.codex/config.toml` and Namo's dedicated Codex configuration. A disabled entry in either environment remains disabled, including when another entry references the same skill through a symlink. Providers, MCP entries, plugin installation settings, and credentials are not imported by this process. The configuration files themselves are not rewritten.

The exact skill access snapshot applies to the newly created runtime. Changes to installed skills or opt-outs are picked up by the next runtime; already running turns retain their permissions. Explicit path denials still take precedence. Automatic memory extraction receives no skill-directory grants and continues to disable shell, plugins, apps, hooks, MCP, and web search.

Skills can have additional executable, authentication, or service dependencies. Read access to skill files does not install those dependencies or grant access to their credentials.

Run `pnpm run smoke:skills` on macOS or Linux to verify the actual Codex sandbox without inference or a Feishu receiver. It checks enabled skill reads, disabled skills, protected configuration/authentication files, parent-directory listings, and write denials. Write checks attempt only fresh empty marker files and immediately remove any unexpected successful creation; existing files are never opened for writing. Output contains counts and skill names, never file contents or credentials.

# 技能访问

普通任务启动前，Namo 使用官方 Codex 协议发现技能，只为已启用的每个技能目录及其真实符号链接目标授予只读权限，不开放用户目录、`.agents`、`.codex` 或插件缓存的父目录。

个人 Codex 与 Namo 专用配置中的技能停用规则会合并，任一处停用均保持停用；只读取技能设置，不导入模型入口、MCP、插件安装配置或凭据，也不改写原配置。新的运行进程读取最新规则，在途任务保持原权限。显式禁止路径仍优先，自动记忆提取不获得技能目录权限。

`pnpm run smoke:skills` 会验证真实沙箱中的读取、停用和写入边界，不调用模型、不启动飞书接收端，也不输出文件内容。技能依赖的程序、认证和服务仍需单独配置。
