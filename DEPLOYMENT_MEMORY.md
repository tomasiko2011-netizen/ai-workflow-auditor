# AI Workflow Auditor - Deployment Memory

Updated: 2026-07-06

## Live deployment

- Vercel URL: https://ai-workflow-auditor-ashen.vercel.app
- Latest deployment URL: https://ai-workflow-auditor-o2nl27z5l-boss-projects-2a53f7d6.vercel.app
- Latest inspect URL: https://vercel.com/boss-projects-2a53f7d6/ai-workflow-auditor/oYCm6RZY8ww7kRrfb8ENLzBoZhJq

## Login

- Username: `admin`
- Password: stored outside git at `/Users/guldana/.ai-workflow-auditor/admin-login.txt`
- `admin/admin` is disabled in production.

## Important architecture note

The local app is the primary working version:

- `server.js`
- SQLite database: `data/auditor.sqlite`
- Persistent local sessions and data
- Run with `npm start`

The Vercel deployment uses:

- `api/[...path].js`
- `vercel.json`
- serverless API
- Neon Postgres durable storage via `DATABASE_URL`
- Table: `app_store`
- Storage model: one JSONB document keyed by `id = 'main'`

The serverless adapter still has an ephemeral `/tmp` fallback for local/dev contexts without `DATABASE_URL`, but production is now durable on Neon.

## Neon

- Organization: `org-sweet-haze-47131396`
- Project: `ai-workflow-auditor`
- Project ID: `curly-scene-87152238`
- Database: `ai_workflow_auditor`
- Region: `aws-eu-central-1`
- Vercel env: `DATABASE_URL` set for Production and Development
- Missing for real usage sync: `OPENAI_ADMIN_KEY`, optional `OPENAI_ORG_ID`, `ANTHROPIC_ADMIN_KEY`

## Current product capabilities

- AI tool usage tracking: Codex, Claude, ChatGPT, Other, Unknown
- Real usage tracking: providers, tools, models, projects, requests, tokens, USD cost
- User-level usage and cost breakdown by AI tool
- Claude CLI status-line batch import for normal subscription usage without API key
- Local Claude CLI monitor agent:
  - Claude statusline bridge installed in `/Users/guldana/.claude/settings.json`
  - Backup: `/Users/guldana/.claude/settings.json.backup-ai-workflow-auditor-1782900361053`
  - LaunchAgent: `/Users/guldana/Library/LaunchAgents/app.ai-workflow-auditor.usage-monitor.plist`
  - State/logs: `/Users/guldana/.ai-workflow-auditor/`
  - Poll interval: 60 seconds
  - Dashboard user/department: `Dana` / `product`
  - Uses `AUDITOR_INGEST_TOKEN`; admin username/password no longer needed by the LaunchAgent
- Dashboard monitor status card:
  - last heartbeat
  - active/observed Claude CLI sessions
  - cost rows
  - last uploaded event count and cost delta
- Usage CSV import and env-ready provider sync
- Usage filters by source, provider, user, project, and date range
- Usage CSV export at `/api/export/usage.csv`
- Usage drill-down by AI session/project with last-seen, tokens, requests, and cost
- Usage session timeline in the Usage tab
- Usage charts by day, week, month, source, project, provider, tool, user, and model
- Usage model comparison table with cost per 1k tokens
- Usage PDF export at `/api/export/usage.pdf`
- Ingestion rate limit for token-based monitor uploads
- Usage retention cleanup (`AUDITOR_USAGE_RETENTION_DAYS`, default 90 days)
- Local statusline snapshot cleanup (`AUDITOR_SNAPSHOT_RETENTION_DAYS`, default 14 days)
- Local project mapping file: `/Users/guldana/.ai-workflow-auditor/project-map.json`
- ROI by AI tool, department, and owner
- Russian tabbed dashboard: overview, tasks, checks, import, users, audit log
- Dashboard charts by AI tool, department, quality, and risks
- Usage pulse widget by AI tool
- Risk matrix by department
- CSV import
- CSV export for tasks and reports
- PDF export
- Users and roles: admin, manager, reviewer, viewer
- Audit log
- Custom rules
- Rule-based insights
- Local smoke tests: `npm test`

## Last verification

- `node --check api/[...path].js`
- `node --check server.js`
- `node --check public/app.js`
- `node --check plugins.js`
- `npm test`
- Neon handler smoke completed successfully.
- Vercel production deploy completed successfully with Russian tabbed UI, expanded charts, usage pulse, risk matrix, usage tracking, Claude CLI status import, JSON usage events endpoint, and local Claude CLI monitor support.
- LaunchAgent verified running via `launchctl print gui/501/app.ai-workflow-auditor.usage-monitor`.
- Live usage verified: `Dana / Claude CLI` events are present with cost and token totals.
- 2026-07-06: Ingestion token configured in Vercel Production/Development and local LaunchAgent.
- 2026-07-06: Live monitor heartbeat verified on production: dashboard receives `activeSessions`, `costRows`, and heartbeat fields.
- 2026-07-06: `ADMIN_PASSWORD` configured in Vercel Production/Development; old `admin/admin` login verified as rejected, configured password verified as accepted.
- 2026-07-06: Usage filters, session drill-down, daily/source/project cost charts, and usage CSV export deployed and live-verified.
- 2026-07-06: Usage PDF export, week/month cost charts, and model comparison table deployed and live-verified.
- 2026-07-06: Ingestion rate limiting, usage retention, local snapshot cleanup, project-map based cwd mapping, and session timeline UI deployed.

## Saved checkpoint - 2026-07-02

What was completed:

- Production dashboard deployed on Vercel and aliased to `https://ai-workflow-auditor-ashen.vercel.app`.
- Durable production storage connected through Neon `DATABASE_URL`.
- Dashboard translated to Russian and reorganized into tabs/subsections.
- Added charts and analytics for ROI, departments, AI tools, quality, risks, and usage.
- Added usage tracking with provider/tool/model/project/user/cost/token breakdowns.
- Added CSV usage import and JSON usage event ingestion endpoint: `POST /api/usage/events`.
- Added Claude CLI manual batch import: `POST /api/usage/cli-status`.
- Added local Claude CLI monitoring:
  - `scripts/claude-statusline-bridge.js` captures the visible Claude CLI statusline.
  - `scripts/usage-monitor.js` watches active/closed Claude sessions and uploads new deltas.
  - macOS LaunchAgent runs monitor every 60 seconds.
- Verified live dashboard already receives `Dana / Claude CLI` usage with cost and token totals.

Recovery/check commands:

```bash
cd "/Users/guldana/Documents/New project/ai-workflow-auditor"
npm test
launchctl print gui/$(id -u)/app.ai-workflow-auditor.usage-monitor
tail -50 ~/.ai-workflow-auditor/usage-monitor.log
npm run usage-monitor -- --user Dana --department product
```

Important local files:

```text
/Users/guldana/.claude/settings.json
/Users/guldana/.claude/settings.json.backup-ai-workflow-auditor-1782900361053
/Users/guldana/Library/LaunchAgents/app.ai-workflow-auditor.usage-monitor.plist
/Users/guldana/.ai-workflow-auditor/usage-monitor-state.json
/Users/guldana/.ai-workflow-auditor/statusline-latest/
```

## Next real production step

Remove default `admin/admin` credentials, add a real admin password, and consider splitting the JSONB store into normalized Postgres tables when usage grows.

## Remaining backlog - saved 2026-07-02

Highest priority:

- Replace default `admin/admin` with a real password and store it only in env/secrets.
- DONE 2026-07-06: Production uses `ADMIN_PASSWORD`; local copy is stored outside git in `~/.ai-workflow-auditor/admin-login.txt`.
- Add a private ingestion token for the local usage monitor, so it does not need the admin login/password.
- DONE 2026-07-06: Added `AUDITOR_INGEST_TOKEN` support and rotated token after setup.
- Add a small UI status card for the monitor:
  - last monitor heartbeat
  - active Claude CLI sessions
  - last uploaded delta
  - last error, if any
- DONE 2026-07-06: Added local monitor status card in the Usage tab.
- Normalize Vercel storage from one JSONB document into proper Postgres tables when usage grows:
  - tasks
  - usage_events
  - users
  - audit_log
  - rules
- Add cleanup/retention policy for old usage events and statusline snapshots.
- DONE 2026-07-06: Added usage retention and local statusline snapshot cleanup.

Product improvements:

- Add per-session drill-down page: session name, cwd/project, model, cost, tokens, open/closed status, timeline.
- DONE 2026-07-06: Added session drill-down table and timeline in Usage tab.
- Add cost charts by day/week/month and by project folder.
- DONE 2026-07-06: Added daily, weekly, monthly, and project-folder cost charts.
- Add model comparison: Opus vs Sonnet, cost per useful task, tokens per result.
- Add filters for usage source:
  - manual CSV
  - CLI status paste
  - local monitor
  - provider API sync
- DONE 2026-07-06: Added source/provider/user/project/date filters.
- Add alerts:
  - weekly usage above threshold
  - session above cost threshold
  - context above threshold
  - too many active sessions
- Add export for usage CSV/PDF, not only tasks/report.
- DONE 2026-07-06: Added usage CSV and PDF exports.

Integration improvements:

- Connect OpenAI/Anthropic admin API sync if real API org keys are added later.
- Add Codex CLI/session monitor if a reliable local usage/status source is available.
- Detect users/projects automatically from cwd mapping instead of always `Dana / product`.
- Add optional Slack/Telegram notification for high spend or blocked sessions.

Quality/security:

- Add e2e Playwright visual smoke for dashboard tabs and charts.
- Add tests for `usage-monitor.js` parsing and dedupe behavior.
- Add rate limiting to ingestion endpoints.
- DONE 2026-07-06: Added token ingestion rate limiting.
- Hide sensitive operational values from UI/logs.
- Commit current repo state once the user approves the snapshot.
