# 用飞书收报告、问经理和批复

BOSS 包含本地飞书接收程序。正式阶段报告会发到已配对的 BOSS 私聊。收到提问或有效批复后，程序通过本机 Codex 的 `queue --thread … --resume` 提醒登记的原经理。请保持电脑、桌面 Codex 和接收服务运行。经理空闲时可自动开始一轮，工作中按原聊天排队接续。只有原经理实际接手，卡片才显示“经理已接手”。[Codex 官方队列说明](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-queue)

已配对后，可以单独发 `/团队` 看阶段、经理简报和每个人手头已登记的任务，或发 `/任务 任务编号` 查交付与验证。接收程序从本地记录直接回复，包括经理忙碌和阶段等批复期间。引用卡片、简报或已有答复时，消息仍交给原经理。

## 首次接入

1. 在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，添加“机器人”，把自己加入可用范围。开通“以应用的身份发消息”和“获取用户发给机器人的单聊消息”权限。在“事件与回调”里选择长连接，事件添加 `im.message.receive_v1`，回调添加新版 `card.action.trigger`，再按租户要求发布应用版本。若后台要求先建立连接，可先运行下面的 `identify` 再保存订阅。[官方长连接说明](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-) · [消息权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)
2. 在已经初始化的业务项目里，将本目录的 `example.env` 复制为 `.boss/feishu.env` 并填写凭证。先在插件源码目录执行 `npm ci --ignore-scripts --prefix integrations/feishu` 安装飞书 SDK。App Secret 只在本机填写。下面命令从 **BOSS 插件开发目录** 在 PowerShell 7 执行。`$project` 指向业务项目，`$config` 指向它自己的凭证文件。

   ```powershell
   $project = (Resolve-Path (Read-Host '输入已初始化的业务项目路径')).Path
   $config = Join-Path $project '.boss/feishu.env'
   $entry = (Resolve-Path '.\integrations\feishu\cli.mjs').Path
   node "--env-file=$config" $entry identify $project
   ```

   照终端提示私聊机器人发送一次性配对码，将终端返回的 `ou_…` 填入配置的 `BOSS_FEISHU_OPEN_ID`。已有本应用下本人 open_id 时可直接填写。

3. 检查配置，启动接收。**启动 serve 会把该项目当前待批报告发给配置里的 BOSS**，随后自动发送新报告。保留一个运行中的终端，按 Ctrl+C 停止。中断后可用同一命令重启。单个飞书应用只运行一个项目接收程序，避免飞书把同一应用的事件分发到其他客户端。

   ```powershell
   node "--env-file=$config" $entry doctor $project
   node "--env-file=$config" $entry serve $project
   ```

4. 启用或升级目标项目的经理说明。这会保留项目 AGENTS.md 的其他内容。若它本身在待批成果清单中，先给原经理看 `manager-guide` 输出，在允许修改时再启用。

   ```powershell
   node $entry enable-manager $project
   ```

   原经理提交后可用 `node $entry delivery $project <报告ID>` 核对飞书消息 ID。工作中，原经理可从 BOSS 工具结果直接看到来信；等员工时用 `wait 0 working` 查件并声明 35 秒内会再查。交报告后用 `wait 60` 等第一条回复。经理在查件窗口内会直接读到来信；窗口失效且仍有未读来信时，程序才投递聊天提醒。提醒使用支持 `queue` 的桌面 CLI，可用 `BOSS_CODEX_BIN` 指定对应可执行文件。桌面与接收服务须使用同一用户和 Codex 配置。CLI 入队、经理接手和飞书回信分别记录。

## 阶段内简报和正式报告

经理通过 boss_brief 发布阶段内进展。简报可引用提问，经理可以用本程序的 brief-delivery 查询简报是否已送达。正式阶段报告附审查员原话、问题和批复表单；提交正式报告后开发派工暂停。经理在桌面的专业任务记录还保留了技能版本、原聊天读取凭据与成果依据。

## 手机上的操作

同一机器人可以轮流服务多个已登记经理的工作区。切换前先处理原工作区未读收件，停止原接收进程。复用已有的凭证文件，将 `serve` 的项目目录改为目标目录，按上面的第 4 步启用目标经理收件。请引用目标工作区的报告卡片；切走后旧卡的回复不会转交新经理。切回原工作区时可以继续使用原项目记录。

- **问经理**：直接私聊机器人即可问当前项目。针对某份报告，可引用那张卡片，例如“这个验收是怎么测的？” 经理会在原消息下答复，也可以引用经理的新答复追问。切换工作区后，普通私聊交给当前绑定的项目。普通“继续”按对话处理。
- **盖章**：选择批准、退回修改或停止，填写意见并提交。若审查有阻断，批准时还须在限制字段中明确填写接受的每个 ID。也可引用回复同一张卡片，第一行单独写 `/批复 退回修改`、`/批复 批准` 或 `/批复 停止`，第二行起写意见。需要逐项接受限制时请用表单。
- **看结果**：提交提示说明接收程序收到了表单。BOSS 校验报告和成果版本后，卡片才显示“批复已收到，经理待接续”；校验未通过会回复原因。原经理读到批示并确认后更新为“经理已接手”。接手后的实际工程进度以经理的后续报告为准。
- **隔天再批**：只要报告仍待批、接收服务在线，意见即可登记。原经理无需事先挂起等待。接收程序每 12 天为仍待批的报告换发一张卡片，以适应飞书卡片的 14 天交互和更新期限。[飞书卡片交互期限](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions)

## 数据和验证

接收程序使用锁定版本的飞书官方 Node SDK 建立出站连接。飞书侧应用和 BOSS 身份、卡片消息 ID、项目与报告版本共同限定批复对象。BOSS 继续负责校验决定。项目 `.boss/feishu.sqlite` 保存卡片、提问、表单原文、事件 ID、接手状态与待发送答复。原经理通过 `CODEX_THREAD_ID` 对照已有角色绑定取件。它提供本机协作约束，同一操作系统用户仍然拥有本机文件权限。

在源码目录运行 `npm test --prefix integrations/feishu`。测试使用真实 BOSS SQLite、飞书 SDK 事件解析、模拟飞书发送端和模拟 Codex 投递端。真机验证可直接私聊问进度，并查看原经理聊天和飞书原消息的答复。
