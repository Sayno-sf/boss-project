# BOSS Project Studio

[简体中文](README.md) · [MIT license](LICENSE)

BOSS is a local Codex plugin for people who want to delegate development to an AI team and keep control of product decisions. A manager assigns work in persistent employee chats, an independent reviewer checks the deliverable, and you approve the next stage. Once the manager submits a formal report, the plugin pauses new development assignments until you decide.

## Start a new project

Use Node.js 24 or later, npm, Git, and a Codex desktop environment that supports local plugin marketplaces and persistent chats. The core uses SQLite built into Node.

```sh
git clone https://github.com/Sayno-sf/boss-project.git
cd boss-project
npm run package
codex plugin marketplace add ./dist --json
codex plugin add boss-project@boss-local --json
codex plugin list --marketplace boss-local --json
```

Open **the folder for the project you want to build** in Codex. Start a chat, select `$boss-project`, and give the manager a small first milestone. For example:

> Set up a BOSS project in this workspace and use this chat as the manager. I want a reading list that remembers my books after I close and reopen it. You may create persistent chats for an independent reviewer, a technical advisor, and the employees needed for the first stage. Tell me what I will be able to try, then wait for my go-ahead.

You can open each team member's chat. Ask the technical advisor how the project works while development continues, or have them walk you through the evidence before you approve a report. The bundled role guides and status labels are primarily in Chinese.

## How a stage works

1. **Agree on an outcome.** The manager turns the idea into something you can try and records how to check it. A stage policy can cap the number of work items and allow parallel tasks with compatible read and write scopes.
2. **Assign and hand over work.** The manager sends each assignment to its registered chat and records the host turn and original reply. Engineering, design, research, and verification tasks can use pinned versions of skills.
3. **Verify and review.** Submitting a deliverable queues an independent review. With two-part review enabled, the reviewer records separate judgments on requirements and implementation quality. A failed regression with a recorded handoff can go back to the original implementer and then to the original tester.
4. **Decide.** The manager explains what works, what remains untested, and what they recommend, with links to the employee and reviewer records. Approve, request changes, or stop the stage with a written comment. Questions can continue while development is paused.

## Where work happens

| Entry point | What it does |
|---|---|
| Codex desktop | The manager uses the host's chat tools during an active turn to deliver assignments. Open the original role chats to inspect the actual exchange. |
| Project folder | Each project keeps its roster, assignments, and approvals under `.boss/`. Project documents hold longer-lived decisions and operating instructions. Run `node src/cli.mjs help` in this checkout for the CLI entry points. |
| Feishu (optional) | A paired owner can receive reports, ask questions, and approve from a private chat. Send `/团队` for the roster or `/任务 <task-id>` for a task. Keep the local listener running; automatic manager notifications also need a desktop CLI with `codex queue`. [Feishu setup guide (Chinese)](integrations/feishu/README.md) |

The queue records and tracks assignments. Delivery to employee chats requires an active manager. Approval gates apply to operations dispatched through the plugin. Project data, chat records, and Feishu credentials are managed locally for each project.

## Development and checks

```sh
npm test
npm ci --ignore-scripts --prefix integrations/feishu
npm test --prefix integrations/feishu
npm run check:package
```

These commands run the core tests, install and test the optional Feishu integration, and verify a packaged installation in an isolated Codex home. The packaging check compares file hashes and starts the installed tool server. Feishu tests use a mock delivery interface.

Role configuration, the collaboration workflow, and the tool reference are available in Chinese: [team setup](skills/boss-project/references/team-setup.md), [collaboration](skills/boss-project/references/collaboration.md), and [dispatch tools](skills/boss-project/references/tools.md).

## License and acknowledgments

BOSS is distributed under the [MIT license](LICENSE). The queue reuses part of the agent-autoloop kernel. Project Context Architect supplies the file-based project context workflow. Their original licenses, credits, and source information are in the [third-party notices](THIRD_PARTY_NOTICES.md).
