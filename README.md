# AI Workflow Auditor (MVP)

Панель для команды, которая хочет видеть не просто список AI-задач, а связь между реальными AI-расходами, экономией времени, качеством и рисками.

## Что умеет

- Логировать задачи до и после AI
- Считать экономию времени
- Показывать качество (число правок, доля одобрений)
- Применять role-based плагины к каждой новой задаче
- Управлять плагинами через UI и API
- Защищать панель простым admin-login
- Фильтровать задачи и строить ROI-отчет по отделам/владельцам
- Редактировать и удалять задачи
- Импортировать задачи из CSV
- Экспортировать задачи и ROI-отчет в CSV
- Вести audit log действий
- Управлять пользователями и ролями
- Создавать custom rules без правки кода
- Показывать rule-based инсайты по отчету
- Сравнивать использование и ROI по AI-инструментам: Codex, Claude, ChatGPT, Other
- Показывать графики по AI-инструментам, отделам, качеству и рискам
- Видеть фактический usage: провайдеры, модели, проекты, запросы, токены и стоимость
- Определять пользователей: кто какие AI-инструменты использовал и сколько это стоило
- Импортировать строку статуса Claude CLI из обычной подписки без API key
- Импортировать usage CSV и синхронизировать usage-провайдеры при наличии admin keys
- Экспортировать PDF-отчет

## Зачем это нужно

Проект отвечает на три практических вопроса:

- Сколько реально стоит AI-работа: OpenAI/Codex, Claude, ChatGPT и другие инструменты.
- Кто именно использовал AI, какие инструменты и сколько это стоило по пользователю.
- Где AI окупается: экономия времени против стоимости, правок и процента одобрений.
- Где нужен контроль: риски, PII/комплаенс, низкий ROI, слабые промпты или лишние правки.

## Хранилище

Локальная версия пишет данные в SQLite:

```text
data/auditor.sqlite
```

При первом запуске приложение переносит старые данные из `data/store.json`, если база еще пустая.

Vercel production использует Neon Postgres через `DATABASE_URL`. Serverless API хранит состояние в таблице `app_store` как JSONB-документ, чтобы сохранить совместимость с локальной SQLite-логикой.

## Плагины (встроенные)

- `marketing-quality`
- `legal-compliance`
- `manager-roi`

Каждый плагин может:
- добавить риск-флаг
- добавить findings/suggestions
- участвовать в метрике использования плагинов

## Запуск

```bash
cd /Users/guldana/Documents/New\ project/ai-workflow-auditor
npm start
```

Открой: `http://localhost:3000`

Логин и пароль по умолчанию:

```text
admin / admin
```

Для реального использования задавай свой пароль:

```bash
ADMIN_PASSWORD='strong-password' npm start
```

Если порт занят:

```bash
PORT=3077 npm start
```

## API

- `GET /api/tasks` - список задач
- `POST /api/tasks` - создать задачу (плагины применяются автоматически)
- `PUT /api/tasks/:id` - обновить задачу
- `DELETE /api/tasks/:id` - удалить задачу
- `PATCH /api/tasks/:id/review` - обновить результат ревью
- `GET /api/metrics` - сводные метрики
- `GET /api/report` - ROI-отчет
- `GET /api/insights` - автоматические инсайты
- `GET /api/export/tasks.csv` - экспорт задач
- `GET /api/export/report.csv` - экспорт отчета
- `GET /api/export/report.pdf` - PDF-отчет
- `POST /api/import/csv` - импорт задач из CSV
- `GET /api/plugins` - список плагинов и статус
- `PATCH /api/plugins/:id` - включить/выключить плагин
- `GET /api/rules` / `POST /api/rules` - custom rules
- `GET /api/users` / `POST /api/users` - пользователи
- `GET /api/audit` - audit log
- `GET /api/usage` - фактическое использование AI
- `POST /api/usage/import` - импорт usage CSV
- `POST /api/usage/sync` - синхронизация usage-провайдеров

Фильтры для `/api/tasks`, `/api/metrics`, `/api/report`:

- `department`
- `aiTool`
- `owner`
- `risk`
- `approved=true|false`
- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`

## Роли

- `admin`: все действия
- `manager`: задачи своего отдела, если отдел указан у пользователя
- `reviewer`: review-обновления
- `viewer`: чтение отчетов и задач

Пароли новых/обновленных пользователей хешируются через `scrypt`. Старые SHA-256 хеши принимаются для совместимости и обновляются при успешном логине. Сессии хранятся в SQLite.

## Тесты

```bash
npm test
```

Smoke-test поднимает отдельный сервер, проверяет login, CRUD задачи, `aiTool` фильтр, CSV/PDF export, usage import/sync и чистит тестовую запись.

## CSV import

Минимальный header:

```csv
title,aiTool,department,owner,withoutAiMinutes,withAiMinutes,revisions,approved,riskFlags
Campaign brief,Codex,marketing,Aida,120,45,1,true,brand-safety
```

## Usage import

Минимальный header:

```csv
provider,tool,model,project,user,department,requests,inputTokens,outputTokens,totalTokens,costUsd,periodStart,periodEnd
openai,Codex,gpt-5.1,main,Dana,product,12,1000,500,1500,1.23,2026-07-01,2026-07-01
```

Для реальной синхронизации в Vercel нужны env-переменные:

```text
OPENAI_ADMIN_KEY
OPENAI_ORG_ID
ANTHROPIC_ADMIN_KEY
```

Production уже хранит usage в Neon. Если ключи не заданы, кнопка синхронизации честно показывает `missing_key`, а импорт CSV остаётся рабочим.

## Claude CLI status import

Для обычной Claude-подписки/API key не нужен. Можно вставить одну или несколько строк из терминала:

```text
botjasau: Model: Sonnet 5 | Cost: $3.48 | Session: 41.0% | Weekly: 51.0% | Ctx Used: 18.0% | Block: 4hr 31m | Weekly Reset: 14hr 18m
main: Model: Sonnet 5 | Cost: $1.20 | Session: 12.0% | Weekly: 52.0% | Ctx Used: 8.0%
```

Она попадёт в usage как:

- provider: `claude-subscription`
- tool: `Claude CLI`
- model: `Sonnet 5`
- costUsd: `3.48`
- user: выбранный пользователь
- project/info: окно/сессия, session %, weekly %, context %

## Автомониторинг Claude CLI сессий

Для нескольких Claude CLI окон можно запустить локальный монитор. Он читает:

- `~/.claude/sessions/*.json` — какие CLI-сессии открыты/закрыты
- `~/.claude/metrics/costs.jsonl` — cumulative cost/tokens из Claude hooks, если файл есть

Монитор отправляет в dashboard только новые дельты, поэтому повторный cron/watch не дублирует стоимость.

Чтобы ловить именно ту строку, которую Claude CLI показывает в терминале (`Cost`, `Session`, `Weekly`, `Ctx Used`), установите statusline bridge. Он прозрачно вызывает ваш прежний `ccstatusline`, но параллельно сохраняет snapshot для монитора:

```bash
npm run usage-monitor:install-statusline
```

Разовая проверка:

```bash
npm run usage-monitor -- --user Dana --department product
```

После production-настройки монитор использует `AUDITOR_INGEST_TOKEN`. Для ручного запуска можно либо экспортировать токен в env, либо оставить обычный LaunchAgent. Fallback через `AUDITOR_USERNAME`/`AUDITOR_PASSWORD` нужен только для локальной разработки.

Постоянный foreground-режим:

```bash
npm run usage-monitor:watch -- --user Dana --department product --interval 60000
```

Автозапуск через macOS LaunchAgent:

```bash
npm run usage-monitor:install -- --user Dana --department product --interval 60000
```

Настройки можно передавать env-переменными:

```text
AUDITOR_URL=https://ai-workflow-auditor-ashen.vercel.app
AUDITOR_INGEST_TOKEN=...
AUDITOR_USAGE_USER=Dana
AUDITOR_USAGE_DEPARTMENT=product
AUDITOR_INTERVAL_MS=60000
AUDITOR_USAGE_RETENTION_DAYS=90
AUDITOR_SNAPSHOT_RETENTION_DAYS=14
AUDITOR_PROJECT_MAP=/Users/guldana/.ai-workflow-auditor/project-map.json
CLAUDE_DIR=/Users/guldana/.claude
```

Если `AUDITOR_INGEST_TOKEN` задан, монитор отправляет usage через `Authorization: Bearer ...` и не использует admin-login/password. Если token не задан, остаётся fallback через `AUDITOR_USERNAME`/`AUDITOR_PASSWORD`.

State и логи:

```text
~/.ai-workflow-auditor/usage-monitor-state.json
~/.ai-workflow-auditor/project-map.json
~/.ai-workflow-auditor/statusline-latest/*.json
~/.ai-workflow-auditor/statusline-snapshots.jsonl
~/.ai-workflow-auditor/usage-monitor.log
~/.ai-workflow-auditor/usage-monitor.err.log
```

## Формат задачи

```json
{
  "title": "Draft campaign brief",
  "department": "marketing",
  "owner": "Aida",
  "withoutAiMinutes": 120,
  "withAiMinutes": 45,
  "revisions": 1,
  "approved": true,
  "riskFlags": ["external-data", "brand-safety"]
}
```
