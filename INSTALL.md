# 安装 BOSS 项目插件

需要 **Node.js 24 或更新版本**，并确保 `node` 和支持插件命令的 `codex` CLI 可从命令行运行。

分发包可在独立的 `CODEX_HOME` 中安装和检查。下列命令安装到当前用户选定的 Codex 环境。

## 安装本地分发包

在本项目根目录执行以下命令。`./dist` 是市场目录，其中包含 `.agents/plugins/marketplace.json` 和 `boss-project/`；如果移动了分发包，将它替换为该市场目录的实际路径。

```sh
node --version
npm run package
codex plugin marketplace add ./dist --json
codex plugin add boss-project@boss-local --json
codex plugin list --marketplace boss-local --json
```

这些安装命令会写入执行者的 Codex 配置。最后一条命令应列出 `boss-project`，并显示 `installed: true` 和 `enabled: true`。目录注册与安装成功，并不证明当前聊天已经加载插件；请以该聊天实际可见的技能与工具为准。

## 开始使用

在 Codex 中调用 `$boss-project`，按[入口技能](skills/boss-project/SKILL.md)绑定项目和角色聊天。

经理、技术员、审查员和员工保留各自的聊天。经理把任务投递到原角色聊天并记录真实回复。启用[飞书接入](integrations/feishu/README.md)后，正式报告自动发往已配对的 BOSS 私聊，飞书收件可唤醒原经理。此功能要求桌面 CLI 支持 `codex queue`。

经理提交阶段报告后，开发派工等待 BOSS 针对该报告和版本给出决定与意见。技术讲解和报告讨论仍可继续。门禁约束插件派工，不能隔离或阻止用户在其他聊天中直接操作项目。
