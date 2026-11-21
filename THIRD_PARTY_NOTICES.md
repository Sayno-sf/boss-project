# Third-party notices

This project includes a limited, unmodified subset of **agent-autoloop** by 数字生命卡兹克.

- Repository: https://github.com/KKKKhazix/agent-autoloop
- Pinned commit: `d3a44cac4460f4e0417c3d407baa853de7aa25ff`
- License: MIT; the full original notice is retained in [vendor/agent-autoloop/LICENSE](vendor/agent-autoloop/LICENSE).
- Provenance: [vendor/agent-autoloop/upstream.json](vendor/agent-autoloop/upstream.json) records each upstream Git blob SHA-1 and local SHA-256. The bytes are unchanged from that commit.

Reused modules:

- `kernel/decide.ts`: event routing, deduplication, claims, results, cards and rule control.
- `kernel/evolve.ts`, `kernel/store.ts`: SQLite fact log, materialized projection and transactional commits.
- `kernel/query.ts`, `kernel/rules.ts`: configuration, execution queries and routing types.
- `kernel/credentials.ts`, `kernel/cron.ts`, `kernel/due.ts`, `kernel/errors.ts`: required deterministic kernel dependencies.
- `protocol/rules.ts`, `protocol/validate.ts`, `protocol/job.ts`: rule/event/result validation and job types.

The upstream host, HTTP server, worker process launcher, CLI, service installer, delivery plugins and model adapters are **not included or executed**. `src/autoloop.mjs` is a local integration wrapper. Project roles, persistent conversation identities and BOSS stage approvals are owned by the surrounding project, not by upstream cards or run completion.

## Project Context Architect

This plugin bundles the **[Project Context Architect](https://github.com/Sayno-sf/Project-context-architect)** skill.

- Copyright (c) 2026 lhq418899-sketch.
- License: MIT; the original notice is retained in [skills/project-context-architect/LICENSE](skills/project-context-architect/LICENSE).
- Provenance: [skills/project-context-architect/SOURCE.json](skills/project-context-architect/SOURCE.json) identifies the project and SHA-256 of all 40 copied files.
- BOSS uses this skill to maintain project context across sessions; it does not grant project approval or replace BOSS stage decisions.
