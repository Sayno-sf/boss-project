# BOSS 项目工作室

[English](README.en.md) · [安装说明](INSTALL.md) · [MIT 许可证](LICENSE)

BOSS 是一个本地 Codex 插件，适合想把开发交给 AI 团队、同时保留关键决定权的人。你提出目标，经理在固定的员工聊天里派工，独立审查员核对实际成果。经理交正式报告后，新的开发派工暂停，等你对这版成果给出决定和意见。

## 从一个新项目开始

准备 Node.js 24 或更新版本、npm、Git，以及支持本地插件市场和持久聊天的 Codex 桌面环境。核心插件使用 Node 内置 SQLite。

```sh
git clone https://github.com/Sayno-sf/boss-project.git
cd boss-project
npm run package
codex plugin marketplace add ./dist --json
codex plugin add boss-project@boss-local --json
codex plugin list --marketplace boss-local --json
```

在 Codex 中打开**你要开发的项目文件夹**，新建聊天，选中 `$boss-project`。例如，发出这条消息：

> 在这个工作区建立 BOSS 项目，让当前聊天担任经理。我的目标是做一个读书清单，关掉再打开还能看到之前的书。我授权你为这个项目创建独立审查员、老技术员和所需员工的固定聊天。先告诉我第一阶段能验收什么，我确认后开工。

经理和员工的聊天可以直接打开。你也可以在开发期间找老技术员了解实现，或在批复前请他解读报告。

## 一轮工作怎样进行

1. **定范围。** 经理把想法整理成可体验的结果，说明用什么动作验收。启用阶段策略后，还可以设工作项上限，并允许读写范围互不冲突的员工并行。
2. **派工与交接。** 经理向员工原聊天投递任务，记录实际轮次和回复。工程、设计、调研和验证岗位可按任务选用固定版本的技能。
3. **验证与审查。** 员工交付会产生独立审查任务。启用双项审查时，审查员分别判断需求是否满足、实现是否可靠。已绑定交接来源的失败复测可以排回原实现员工修复，再交原验证员。
4. **报告与批复。** 经理用日常语言说明做到了什么、还有什么没测、建议如何处理，附上员工报告、审查记录和版本。你可以批准、退回或停止。等待批复期间仍能提问。

## 桌面、项目文件和飞书

| 入口 | 用来做什么 |
|---|---|
| Codex 桌面 | 经理在工作轮次中使用宿主聊天工具向员工投递任务；老板可以直接查看各角色的实际交流。 |
| 项目目录 | `.boss/` 保存角色绑定、派工和批复记录。项目文档保存长期决定和运行说明。命令行可用 `node src/cli.mjs help` 查看入口。 |
| 飞书（可选） | 已配对的老板可从手机接收报告、提问和批复。发 `/团队` 或 `/任务 任务编号` 可直接查台账。需要本地接收进程在线，自动提醒经理还需要支持 `codex queue` 的桌面 CLI。[配置飞书](integrations/feishu/README.md) |

后台队列能登记和追踪派工；把任务送入员工聊天需要运行中的经理。阶段冻结约束插件自身的派工入口。业务文件、聊天记录和飞书凭据由各项目在本机管理。

## 开发与验证

```sh
npm test
npm ci --ignore-scripts --prefix integrations/feishu
npm test --prefix integrations/feishu
npm run check:package
```

前三条运行核心及飞书隔离测试。最后一条在独立的 Codex 配置目录中安装分发包，逐文件核对并启动插件工具服务。测试使用临时项目，飞书测试使用模拟发送接口。

[岗位和技能配置](skills/boss-project/references/team-setup.md) · [团队协作](skills/boss-project/references/collaboration.md) · [工具与派工](skills/boss-project/references/tools.md)

## 许可证与致谢

BOSS 使用 [MIT 许可证](LICENSE)。事件队列复用了 agent-autoloop 的部分内核，项目文档管理使用 Project Context Architect。两者的原始许可证、署名和来源见[第三方说明](THIRD_PARTY_NOTICES.md)。
