# AI Workflow Auditor (MVP)

Минимальный MVP для команды, которая хочет видеть реальную пользу от AI в ежедневной работе.

## Что умеет

- Логировать задачи до и после AI
- Считать экономию времени
- Показывать качество (число правок, доля одобрений)
- Применять role-based плагины к каждой новой задаче
- Управлять плагинами через UI и API

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

Если порт занят:

```bash
PORT=3077 npm start
```

## API

- `GET /api/tasks` - список задач
- `POST /api/tasks` - создать задачу (плагины применяются автоматически)
- `PATCH /api/tasks/:id/review` - обновить результат ревью
- `GET /api/metrics` - сводные метрики
- `GET /api/plugins` - список плагинов и статус
- `PATCH /api/plugins/:id` - включить/выключить плагин

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
