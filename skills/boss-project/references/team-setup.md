# 团队配置与交接

在 boss_status 的 roles 中看员工名册（岗位、职责、技能和原聊天）。用 boss_profile 写入该角色完整配置，保留已有角色和聊天。已有项目可逐个补资料。从插件自带的 boss-engineer、boss-designer、boss-researcher、boss-verifier 中选择，也可指定已获准使用的本地专业技能。

例如对已登记的设计师调用 boss_profile，附上业务项目 root 和下列参数。

```json
{"role":"designer","specialty":"产品设计","responsibility":"负责导览动线和交互验收","skills":[{"name":"导览设计","version":"0.2.0","directory":"@boss/skills/boss-designer"}]}
```

directory 可以是插件内的 @boss/ 路径、项目相对目录或授权的本机技能目录。登记时保存 SKILL.md，以及 resources 明确列出的相对文件（包括该技能需要的脚本、图片和参考材料）。版本标签便于人阅读，文件摘要决定实际内容。变更后更新名册，新派的任务才选择新版。原任务保留当时的文件快照。

派工用 boss_assign，沿用已有 role、text、materials、modelPlan，按任务选择 skillNames。handoff 形如 `{"acceptance":"从正门沿标识进入第二厅","output":"可运行的路线样板和录屏","to":"verifier"}`，to 填已登记的接手人 ID。前序任务完成后，经理在给接手人的 boss_assign 上写 fromJob。系统核对收件人，把上游版本或产物、验证、剩余问题和原始回执带进新的派工消息。原员工调用 boss_read_skill，参数为 jobId 和 name。工具从原聊天返回当时的内容与资源目录。经理用 boss_complete 保存真实回复及出处，同时给出 workEvidence 的 artifact、validation、remaining。有指定技能时，附 skillUse 数组，逐项填写 name、status（used 或 unused）和 evidence，用产物定位说明用在何处，未用则写原因。

收到试用反馈时，用 boss_feedback 保存稳定 ID、原话、来源、负责人和分类（defect 缺陷、change 需求变化、experience 体验意见）。缺陷必须给 scenario 和 expected，可复测的体验问题也能补这两项。登记需求变化后由经理判断授权，重大变化请 BOSS 决定。之后的相关任务在 feedbackIds 引用原 ID，原员工用 boss_regression 记录 jobId、feedbackId、outcome（pass、fail、unverified）、version 和 evidence。修复前失败与修复后通过的记录均保留。下一阶段仍可引用同一场景再测。

进展简报用 boss_brief 的 id、stageId、message、sourceRef。id 在重试时沿用。经理可用飞书 CLI 的 brief-delivery 查简报消息 ID。飞书接收程序会发送简报，BOSS 可以引用提问；简报不产生审批。正式报告用 boss_report，审查和盖章沿用原流程。工作中的对话与飞书报告写法见[经理汇报写法](../../boss-manager/references/reporting.md)。
