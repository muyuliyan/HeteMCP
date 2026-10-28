# DeepSeek file-generation connectivity test

This opt-in Windows profile runs the installed Desktop 0.2.1-rc.2 through HeteMCP's real MCP
stdio transport. Codex designs and reviews; DeepSeek writes the C++ file. No C++ source is
embedded in the task specification, client, or verifier.

```powershell
npm run build
$env:HETEMCP_DSH_DESKTOP = 'D:/path/to/deepseek-desktop'
$env:HETEMCP_CREDENTIALS_PATH = 'C:/path/to/.credentials.yaml'
$env:HETEMCP_ALLOW_UNMETERED = '1'
node node_modules/tsx/dist/cli.mjs scripts/run-file-task.ts config/bubble-task.json
```

Replace paths with your installation and credentials file, and run from the repository root.
The service does not automatically load `.env`. For retained task records, set
`HETEMCP_DATABASE_URL` in the client environment before invocation; the script explicitly
forwards it to the MCP service. Without it, storage is in-memory even though the client saves
a run snapshot. Never print the connection string. The checked-in Compose database uses tmpfs
and is disposable; manage durable PostgreSQL storage separately.

The credential path is passed to the native credentials plugin; keys are never copied into
task records or prompts. HeteMCP uses its own `.heteromcp/dsh-home` and an explicit policy
overlay, leaving the desktop profile unchanged. The worker's cwd is a fresh attempt workspace,
with workspace-write and approval never. Shell, web, delegation and plugin-management tools
are disabled. A denied operation is not retried with broader access.

`HETEMCP_ALLOW_UNMETERED=1` explicitly acknowledges that token/cost fields are advisory for
this smoke profile. Usage zeros with `measured=false` mean unknown, not free. The 120-second
wall-clock limit is enforced. Use a compatible pinned runtime; newer desktop releases need
their protocol and policy checked before selecting this compatibility mode.

The client prints the task ID and saves `.heteromcp/runs/<task-id>.json`. A successful generation
means only a completed Harness turn and independent file scope validation. Review the returned
source before running the separate compiler/behavior verifier:

```powershell
$env:HETEMCP_CXX = 'D:/path/to/g++.exe'
node node_modules/tsx/dist/cli.mjs scripts/verify-bubble.ts .heteromcp/runs/<task-id>.json
```

Add `--publish` to copy the verified source into `test/bubble.cpp`. Publication refuses to
overwrite a nonempty file. It checks the source hash before compilation and confirms identical
published bytes. The verifier exercises 57 valid and 3 invalid inputs and writes
`supervisor-verification.json` next to the attempt report. Generated binaries and session data
stay under ignored `.heteromcp/`. No commit or push is performed.

Back up task records and artifact files together; a database backup cannot restore file URIs
by itself. For local archives and publication boundaries, see
[repository-layout.md](repository-layout.md).

## Verified run

- Date: 2026-10-26, Asia/Shanghai.
- Task: `4be8fde4-a5ac-4333-ab97-a745eec0091d`.
- Attempt: `b0ea723e-cca1-4f35-8738-70f7d9105b15`.
- Harness session: `session-4f4df263-5835-4747-91a4-f76e76f48482`.
- Source SHA-256: `c9a3afcf0bbc5e17b1510a5fbcedb74629be41367bc49f5d50b130fcf4d1e3a5`.
- Compiler flags: `-std=c++17 -Wall -Wextra -Werror -pedantic`; exit 0.
- 60 behavior tests passed; the worker-authored file was published without edits.
- Evidence directory: `.heteromcp/artifacts/4be8fde4-a5ac-4333-ab97-a745eec0091d/b0ea723e-cca1-4f35-8738-70f7d9105b15/`.

This remains a bounded new-file proof of connectivity. It does not implement general repository
editing, enforced token/cost budgets, automatic merging, or a production acceptance pipeline.
