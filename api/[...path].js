const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { AVAILABLE_PLUGINS, normalizePluginState, executePlugins } = require('../plugins');

const STORE_PATH = path.join('/tmp', 'ai-workflow-auditor-store.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'admin').trim();

function nowIso() {
  return new Date().toISOString();
}

function seedStore() {
  return {
    tasks: [
      {
        id: 'demo_legal_1',
        createdAt: '2026-02-25T06:15:27.231Z',
        title: 'Prepare contract policy draft with client-data',
        aiTool: 'Unknown',
        department: 'legal',
        owner: 'Dana',
        withoutAiMinutes: 100,
        withAiMinutes: 70,
        revisions: 1,
        approved: false,
        riskFlags: ['compliance', 'pii'],
        pluginFindings: [
          { pluginId: 'legal-compliance', text: 'Добавлен риск compliance: найден юридический контекст.' },
          { pluginId: 'legal-compliance', text: 'Добавлен риск pii: найдены признаки персональных данных.' }
        ],
        pluginSuggestions: [{ pluginId: 'legal-compliance', text: 'Попросите юридическое ревью перед отправкой клиенту.' }],
        pluginApplied: ['marketing-quality', 'legal-compliance']
      }
    ],
    pluginState: { 'marketing-quality': true, 'legal-compliance': true, 'manager-roi': false },
    users: [
      { username: 'admin', password: ADMIN_PASSWORD, role: 'admin', department: '', created_at: nowIso() }
    ],
    sessions: {},
    monitorStatus: null,
    rules: [],
    usageEvents: [],
    audit: []
  };
}

async function ensureDbStore() {
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS app_store (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

async function readStore() {
  if (sql) {
    await ensureDbStore();
    const rows = await sql`SELECT data FROM app_store WHERE id = 'main' LIMIT 1`;
    if (rows[0]?.data) return rows[0].data;
    const store = seedStore();
    await writeStore(store);
    return store;
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    const store = seedStore();
    await writeStore(store);
    return store;
  }
}

async function writeStore(store) {
  if (sql) {
    await ensureDbStore();
    await sql`INSERT INTO app_store (id, data, updated_at)
      VALUES ('main', ${JSON.stringify(store)}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = now()`;
    return;
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const idx = item.indexOf('=');
        return [decodeURIComponent(item.slice(0, idx)), decodeURIComponent(item.slice(idx + 1))];
      })
  );
}

function publicUser(user) {
  return { username: user.username, role: user.role, department: user.department || '' };
}

function currentUser(req, store) {
  const token = parseCookies(req.headers.cookie).auditor_session;
  const session = token ? store.sessions[token] : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) delete store.sessions[token];
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.user;
}

function setSession(res, store, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.sessions[token] = { user, expiresAt: Date.now() + SESSION_TTL_MS };
  res.setHeader('Set-Cookie', `auditor_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSession(req, res, store) {
  const token = parseCookies(req.headers.cookie).auditor_session;
  if (token) delete store.sessions[token];
  res.setHeader('Set-Cookie', 'auditor_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function validIngestToken(req) {
  const expected = String(process.env.AUDITOR_INGEST_TOKEN || '').trim();
  const received = bearerToken(req);
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function monitorStatusFromBody(body = {}, events = []) {
  const monitor = body.monitor && typeof body.monitor === 'object' ? body.monitor : {};
  const now = nowIso();
  const totalCostDelta = events.reduce((sum, event) => sum + (Number(event.costUsd) || 0), 0);
  return {
    lastHeartbeatAt: now,
    lastUploadAt: events.length ? now : String(monitor.lastUploadAt || ''),
    activeSessions: Number(monitor.activeSessions ?? 0) || 0,
    observedSessions: Number(monitor.observedSessions ?? monitor.activeSessions ?? 0) || 0,
    costRows: Number(monitor.costRows ?? 0) || 0,
    lastUploadedEvents: events.length,
    lastCostDeltaUsd: +totalCostDelta.toFixed(6),
    lastError: String(monitor.lastError || ''),
    user: String(monitor.user || body.user || ''),
    department: String(monitor.department || body.department || ''),
    source: String(monitor.source || 'usage-monitor'),
    version: String(monitor.version || '')
  };
}

function text(res, code, payload, contentType, filename) {
  res.statusCode = code;
  res.setHeader('Content-Type', contentType);
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function logAudit(store, user, action, targetType, targetId, details = {}) {
  store.audit.unshift({
    id: `a_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    created_at: nowIso(),
    actor: user?.username || 'system',
    role: user?.role || 'system',
    action,
    target_type: targetType,
    target_id: targetId || null,
    details
  });
  store.audit = store.audit.slice(0, 200);
}

function userCanWrite(user, task = null) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'manager') return !task || !user.department || task.department === user.department;
  return false;
}

function filterTasks(tasks, params, user) {
  return tasks.filter(task => {
    if (user?.role === 'manager' && user.department && task.department !== user.department) return false;
    if (params.department && task.department !== params.department) return false;
    if (params.aiTool && task.aiTool !== params.aiTool) return false;
    if (params.owner && !task.owner.toLowerCase().includes(params.owner.toLowerCase())) return false;
    if (params.approved === 'true' && !task.approved) return false;
    if (params.approved === 'false' && task.approved) return false;
    if (params.risk && !(task.riskFlags || []).includes(params.risk)) return false;
    if (params.from && new Date(task.createdAt) < new Date(params.from)) return false;
    if (params.to && new Date(task.createdAt) > new Date(`${params.to}T23:59:59`)) return false;
    return true;
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function applyRules(store, baseTask, pluginResult) {
  const risks = [...pluginResult.riskFlags];
  const findings = [...pluginResult.pluginFindings];
  const suggestions = [...pluginResult.pluginSuggestions];
  const applied = [...pluginResult.pluginApplied];
  const joined = `${baseTask.title} ${(baseTask.riskFlags || []).join(' ')}`.toLowerCase();
  const saved = Math.max(baseTask.withoutAiMinutes - baseTask.withAiMinutes, 0);
  const roi = baseTask.withoutAiMinutes ? saved / baseTask.withoutAiMinutes * 100 : 0;

  for (const rule of store.rules.filter(item => item.enabled)) {
    if (rule.matchText && !joined.includes(rule.matchText.toLowerCase())) continue;
    if (rule.matchDepartment && rule.matchDepartment !== baseTask.department) continue;
    if (rule.minRevisions !== '' && rule.minRevisions !== undefined && baseTask.revisions < Number(rule.minRevisions)) continue;
    if (rule.maxRoiPercent !== '' && rule.maxRoiPercent !== undefined && roi > Number(rule.maxRoiPercent)) continue;
    if (rule.addRisk && !risks.includes(rule.addRisk)) risks.push(rule.addRisk);
    if (rule.finding) findings.push({ pluginId: `rule:${rule.id}`, text: rule.finding });
    if (rule.suggestion) suggestions.push({ pluginId: `rule:${rule.id}`, text: rule.suggestion });
    applied.push(`rule:${rule.name}`);
  }
  return { riskFlags: risks, pluginFindings: findings, pluginSuggestions: suggestions, pluginApplied: applied };
}

function taskFromBody(store, body, existing = {}) {
  const baseTask = {
    id: existing.id || `t_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: existing.id ? nowIso() : undefined,
    title: String(body.title ?? existing.title ?? '').trim(),
    aiTool: String(body.aiTool ?? existing.aiTool ?? 'Unknown').trim() || 'Unknown',
    department: String(body.department ?? existing.department ?? '').trim(),
    owner: String(body.owner ?? existing.owner ?? '').trim(),
    withoutAiMinutes: Number(body.withoutAiMinutes ?? existing.withoutAiMinutes) || 0,
    withAiMinutes: Number(body.withAiMinutes ?? existing.withAiMinutes) || 0,
    revisions: Number(body.revisions ?? existing.revisions) || 0,
    approved: Boolean(body.approved ?? existing.approved),
    riskFlags: Array.isArray(body.riskFlags) ? body.riskFlags.map(String).filter(Boolean) : existing.riskFlags || []
  };
  if (!baseTask.title || !baseTask.department || !baseTask.owner) throw new Error('title, department, owner are required');
  const builtIn = executePlugins(baseTask, normalizePluginState(store.pluginState));
  return { ...baseTask, ...applyRules(store, baseTask, builtIn) };
}

function metrics(tasks) {
  const total = tasks.length;
  const totalBefore = tasks.reduce((sum, task) => sum + task.withoutAiMinutes, 0);
  const totalAfter = tasks.reduce((sum, task) => sum + task.withAiMinutes, 0);
  const savedMinutes = Math.max(totalBefore - totalAfter, 0);
  const riskCounters = {};
  const pluginUsage = {};
  for (const task of tasks) {
    for (const risk of task.riskFlags || []) riskCounters[risk] = (riskCounters[risk] || 0) + 1;
    for (const plugin of task.pluginApplied || []) pluginUsage[plugin] = (pluginUsage[plugin] || 0) + 1;
  }
  return {
    totalTasks: total,
    totalBeforeMinutes: totalBefore,
    totalAfterMinutes: totalAfter,
    savedMinutes,
    savedHours: +(savedMinutes / 60).toFixed(2),
    approvalRate: total ? +(tasks.filter(task => task.approved).length / total * 100).toFixed(1) : 0,
    revisionsAvg: total ? +(tasks.reduce((sum, task) => sum + task.revisions, 0) / total).toFixed(2) : 0,
    riskCounters,
    pluginUsage
  };
}

function normalizeUsageEvent(input = {}) {
  const provider = String(input.provider || input.vendor || input.source || 'openai').trim().toLowerCase();
  const tool = String(input.tool || input.aiTool || provider).trim() || provider;
  const model = String(input.model || input.line_item || input.lineItem || '').trim();
  const requests = Number(input.requests ?? input.nummodelrequests ?? input.num_model_requests ?? input.num_requests ?? 0) || 0;
  const inputTokens = Number(input.inputTokens ?? input.inputtokens ?? input.input_tokens ?? 0) || 0;
  const outputTokens = Number(input.outputTokens ?? input.outputtokens ?? input.output_tokens ?? 0) || 0;
  const totalTokens = Number(input.totalTokens ?? input.totaltokens ?? input.total_tokens ?? inputTokens + outputTokens) || 0;
  const costUsd = Number(input.costUsd ?? input.costusd ?? input.cost_usd ?? input.cost ?? input.amount ?? 0) || 0;
  const createdAt = String(input.createdAt || input.created_at || input.date || input.periodStart || nowIso());
  return {
    id: input.id || `u_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    createdAt,
    periodStart: String(input.periodStart || input.periodstart || input.period_start || input.start_time || createdAt),
    periodEnd: String(input.periodEnd || input.periodend || input.period_end || input.end_time || createdAt),
    provider,
    tool,
    model,
    project: String(input.project || input.project_id || '').trim(),
    user: String(input.user || input.user_id || input.owner || '').trim(),
    department: String(input.department || '').trim(),
    requests,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: +costUsd.toFixed(6),
    source: String(input.source || 'manual').trim()
  };
}

function usageSummary(events = []) {
  const totalCostUsd = events.reduce((sum, event) => sum + (Number(event.costUsd) || 0), 0);
  const totalTokens = events.reduce((sum, event) => sum + (Number(event.totalTokens) || 0), 0);
  const totalRequests = events.reduce((sum, event) => sum + (Number(event.requests) || 0), 0);
  const group = key => Object.values(events.reduce((acc, event) => {
    const label = event[key] || 'unknown';
    acc[label] ||= { label, events: 0, costUsd: 0, tokens: 0, requests: 0 };
    acc[label].events += 1;
    acc[label].costUsd += Number(event.costUsd) || 0;
    acc[label].tokens += Number(event.totalTokens) || 0;
    acc[label].requests += Number(event.requests) || 0;
    return acc;
  }, {})).map(row => ({ ...row, costUsd: +row.costUsd.toFixed(4) })).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
  const byUser = group('user');
  const userToolRows = Object.values(events.reduce((acc, event) => {
    const user = event.user || 'unknown';
    const tool = event.tool || event.provider || 'unknown';
    const key = `${user}::${tool}`;
    acc[key] ||= { user, tool, events: 0, costUsd: 0, tokens: 0, requests: 0 };
    acc[key].events += 1;
    acc[key].costUsd += Number(event.costUsd) || 0;
    acc[key].tokens += Number(event.totalTokens) || 0;
    acc[key].requests += Number(event.requests) || 0;
    return acc;
  }, {})).map(row => ({ ...row, costUsd: +row.costUsd.toFixed(4) })).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
  return {
    totalEvents: events.length,
    totalCostUsd: +totalCostUsd.toFixed(4),
    totalTokens,
    totalRequests,
    byProvider: group('provider'),
    byTool: group('tool'),
    byModel: group('model'),
    byProject: group('project'),
    byUser,
    userToolRows,
    lastUpdated: events[0]?.createdAt || null
  };
}

function parseUsageCsv(csv) {
  return parseCsv(csv).map(row => normalizeUsageEvent(row));
}

function parseCliStatusLine(line, defaults = {}) {
  const textValue = String(line || '').trim();
  if (!textValue) throw new Error('CLI status line is required');
  const prefixMatch = textValue.match(/^([^|:]{2,80}):\s*(Model:\s*)/i);
  const sessionLabel = String(defaults.session || (prefixMatch ? prefixMatch[1] : '') || '').trim();
  const statusText = prefixMatch ? textValue.slice(prefixMatch[1].length + 1).trim() : textValue;
  const pick = pattern => {
    const match = statusText.match(pattern);
    return match ? match[1].trim() : '';
  };
  const model = pick(/Model:\s*([^|]+)/i) || pick(/^([^|]+)/i) || 'Claude CLI';
  const cost = Number(pick(/Cost:\s*\$?([0-9]+(?:\.[0-9]+)?)/i)) || 0;
  const sessionPct = pick(/Session:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const weeklyPct = pick(/Weekly:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const ctxPct = pick(/Ctx Used:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const block = pick(/Block:\s*([^|]+)/i);
  const weeklyReset = pick(/Weekly Reset:\s*([^|]+)/i);
  return normalizeUsageEvent({
    provider: 'claude-subscription',
    tool: 'Claude CLI',
    model,
    user: defaults.user,
    department: defaults.department,
    project: [sessionLabel ? `окно ${sessionLabel}` : '', `session ${sessionPct || '-'}%`, `weekly ${weeklyPct || '-'}%`, `ctx ${ctxPct || '-'}%`].filter(Boolean).join(' / '),
    requests: 1,
    costUsd: cost,
    periodStart: nowIso(),
    periodEnd: nowIso(),
    source: 'claude-cli-status',
    notes: [block ? `block ${block}` : '', weeklyReset ? `weekly reset ${weeklyReset}` : ''].filter(Boolean).join('; ')
  });
}

function parseCliStatusBlock(text, defaults = {}) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => parseCliStatusLine(line, defaults));
}

async function syncUsageProviders(store) {
  const results = [];
  if (!process.env.OPENAI_ADMIN_KEY) {
    results.push({ provider: 'openai', status: 'missing_key', message: 'OPENAI_ADMIN_KEY не задан в Vercel env' });
  } else {
    try {
      const end = Math.floor(Date.now() / 1000);
      const start = end - 30 * 24 * 60 * 60;
      const url = new URL('https://api.openai.com/v1/organization/costs');
      url.searchParams.set('start_time', String(start));
      url.searchParams.set('end_time', String(end));
      url.searchParams.set('bucket_width', '1d');
      url.searchParams.set('group_by', 'project_id,line_item');
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_ADMIN_KEY}`,
          ...(process.env.OPENAI_ORG_ID ? { 'OpenAI-Organization': process.env.OPENAI_ORG_ID } : {})
        }
      });
      if (!res.ok) throw new Error(`OpenAI Usage API HTTP ${res.status}`);
      const payload = await res.json();
      const imported = [];
      for (const bucket of payload.data || []) {
        for (const item of bucket.results || []) {
          imported.push(normalizeUsageEvent({
            provider: 'openai',
            tool: 'OpenAI API',
            model: item.line_item || item.model || '',
            project: item.project_id || '',
            requests: item.num_model_requests || item.num_requests || 0,
            costUsd: item.amount?.value || 0,
            periodStart: new Date((bucket.start_time || start) * 1000).toISOString(),
            periodEnd: new Date((bucket.end_time || end) * 1000).toISOString(),
            source: 'openai-costs-api'
          }));
        }
      }
      store.usageEvents = [...imported, ...(store.usageEvents || [])].slice(0, 2000);
      results.push({ provider: 'openai', status: 'ok', imported: imported.length });
    } catch (err) {
      results.push({ provider: 'openai', status: 'error', message: err.message });
    }
  }
  if (!process.env.ANTHROPIC_ADMIN_KEY) {
    results.push({ provider: 'anthropic', status: 'missing_key', message: 'ANTHROPIC_ADMIN_KEY не задан в Vercel env' });
  } else {
    results.push({ provider: 'anthropic', status: 'configured', message: 'Ключ найден; подключение Usage/Cost API готово к расширению под ваш plan/workspace' });
  }
  return { results, summary: usageSummary(store.usageEvents || []) };
}

function groupBy(tasks, key) {
  const grouped = {};
  for (const task of tasks) {
    const label = task[key] || 'unknown';
    grouped[label] ||= { label, tasks: 0, savedMinutes: 0, approved: 0, revisions: 0 };
    grouped[label].tasks += 1;
    grouped[label].savedMinutes += Math.max(task.withoutAiMinutes - task.withAiMinutes, 0);
    grouped[label].approved += task.approved ? 1 : 0;
    grouped[label].revisions += task.revisions;
  }
  return Object.values(grouped).map(row => ({
    ...row,
    savedHours: +(row.savedMinutes / 60).toFixed(2),
    approvalRate: row.tasks ? +(row.approved / row.tasks * 100).toFixed(1) : 0,
    revisionsAvg: row.tasks ? +(row.revisions / row.tasks).toFixed(2) : 0
  })).sort((a, b) => b.savedMinutes - a.savedMinutes);
}

function report(tasks) {
  return {
    generatedAt: nowIso(),
    metrics: metrics(tasks),
    byDepartment: groupBy(tasks, 'department'),
    byTool: groupBy(tasks, 'aiTool'),
    byOwner: groupBy(tasks, 'owner'),
    lowRoiTasks: tasks.map(task => {
      const savedMinutes = Math.max(task.withoutAiMinutes - task.withAiMinutes, 0);
      return { id: task.id, title: task.title, owner: task.owner, department: task.department, savedMinutes, roiPercent: task.withoutAiMinutes ? +(savedMinutes / task.withoutAiMinutes * 100).toFixed(1) : 0, revisions: task.revisions };
    }).filter(task => task.roiPercent < 20 || task.revisions >= 3).slice(0, 8)
  };
}

function insights(rep) {
  if (!rep.metrics.totalTasks) return [{ level: 'info', text: 'Данных пока мало: импортируйте историю или заведите первые AI-задачи.' }];
  const items = [];
  if (rep.byDepartment[0]) items.push({ level: 'positive', text: `${rep.byDepartment[0].label}: лидер по экономии, ${rep.byDepartment[0].savedHours} ч на ${rep.byDepartment[0].tasks} задач.` });
  if (rep.byTool[0]) items.push({ level: 'positive', text: `${rep.byTool[0].label}: самый полезный AI-инструмент по экономии, ${rep.byTool[0].savedHours} ч.` });
  const weak = [...rep.byDepartment].sort((a, b) => a.approvalRate - b.approvalRate)[0];
  if (weak && weak.approvalRate < 70) items.push({ level: 'warning', text: `${weak.label}: доля одобренных задач ${weak.approvalRate}%. Нужен ревью промптов и критериев качества.` });
  if (rep.lowRoiTasks.length) items.push({ level: 'warning', text: `${rep.lowRoiTasks.length} задач требуют внимания из-за низкого ROI или большого числа правок.` });
  return items.slice(0, 5);
}

function csvCell(value) {
  const textValue = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return `"${textValue.replaceAll('"', '""')}"`;
}

function tasksCsv(tasks) {
  const rows = [['id', 'createdAt', 'title', 'aiTool', 'department', 'owner', 'withoutAiMinutes', 'withAiMinutes', 'savedMinutes', 'revisions', 'approved', 'riskFlags', 'pluginApplied']];
  for (const task of tasks) rows.push([task.id, task.createdAt, task.title, task.aiTool, task.department, task.owner, task.withoutAiMinutes, task.withAiMinutes, Math.max(task.withoutAiMinutes - task.withAiMinutes, 0), task.revisions, task.approved, task.riskFlags, task.pluginApplied]);
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

function reportCsv(rep) {
  const rows = [['section', 'label', 'tasks', 'savedHours', 'approvalRate', 'revisionsAvg']];
  for (const row of rep.byDepartment) rows.push(['department', row.label, row.tasks, row.savedHours, row.approvalRate, row.revisionsAvg]);
  for (const row of rep.byTool) rows.push(['tool', row.label, row.tasks, row.savedHours, row.approvalRate, row.revisionsAvg]);
  for (const row of rep.byOwner) rows.push(['owner', row.label, row.tasks, row.savedHours, row.approvalRate, row.revisionsAvg]);
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

function pdfText(value) {
  return String(value ?? '').replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?');
}

function simplePdf(lines) {
  const content = ['BT', '/F1 12 Tf', '50 790 Td'];
  for (const [idx, line] of lines.entries()) {
    if (idx) content.push('0 -18 Td');
    content.push(`(${pdfText(line).slice(0, 95)}) Tj`);
  }
  content.push('ET');
  const stream = content.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${obj}\n`;
  }
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return pdf;
}

function reportPdf(rep, ins) {
  const lines = ['Отчёт аудитора AI-процессов', `Сформирован: ${rep.generatedAt}`, `Задач: ${rep.metrics.totalTasks}`, `Сэкономлено часов: ${rep.metrics.savedHours}`, `Одобрено: ${rep.metrics.approvalRate}%`, '', 'По AI-инструментам:'];
  for (const row of rep.byTool) lines.push(`${row.label}: ${row.savedHours} ч экономии, задач ${row.tasks}, одобрено ${row.approvalRate}%`);
  lines.push('', 'Инсайты:');
  for (const item of ins) lines.push(`- ${item.text}`);
  return simplePdf(lines);
}

function parseCsv(textValue) {
  const lines = String(textValue || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(item => item.trim());
  return lines.slice(1).map(line => Object.fromEntries(line.split(',').map((value, idx) => [headers[idx], value.trim()])));
}

module.exports = async function handler(req, res) {
  const store = await readStore();
  const queryPath = req.query.path || [];
  const rawPath = `/${(Array.isArray(queryPath) ? queryPath : String(queryPath).split('/')).filter(Boolean).join('/')}`;
  const params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries());

  try {
    if (req.method === 'GET' && rawPath === '/session') return json(res, 200, { authenticated: Boolean(currentUser(req, store)), user: currentUser(req, store) });

    if (req.method === 'POST' && rawPath === '/login') {
      const body = await readBody(req);
      const found = store.users.find(user => user.username === String(body.username || 'admin'));
      const expectedPassword = found?.username === 'admin' && process.env.ADMIN_PASSWORD ? ADMIN_PASSWORD : found?.password;
      if (!found || expectedPassword !== String(body.password || '')) return json(res, 401, { error: 'Invalid username or password' });
      const user = publicUser(found);
      setSession(res, store, user);
      logAudit(store, user, 'login', 'session', user.username);
      await writeStore(store);
      return json(res, 200, { authenticated: true, user });
    }

    if (req.method === 'POST' && rawPath === '/logout') {
      const user = currentUser(req, store);
      if (user) logAudit(store, user, 'logout', 'session', user.username);
      clearSession(req, res, store);
      await writeStore(store);
      return json(res, 200, { authenticated: false });
    }

    if (req.method === 'POST' && rawPath === '/usage/events' && validIngestToken(req)) {
      const body = await readBody(req);
      const rawEvents = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : []);
      const events = rawEvents.filter(Boolean).map(event => normalizeUsageEvent(event));
      const byId = new Map((store.usageEvents || []).map(event => [event.id, event]));
      for (const event of events) byId.set(event.id, event);
      store.usageEvents = [...events, ...Array.from(byId.values()).filter(event => !events.some(item => item.id === event.id))].slice(0, 2000);
      store.monitorStatus = monitorStatusFromBody(body, events);
      logAudit(store, { username: 'usage-monitor', role: 'system', department: '' }, 'monitor_heartbeat', 'usage', null, store.monitorStatus);
      await writeStore(store);
      return json(res, 200, { imported: events.length, events, monitor: store.monitorStatus, summary: usageSummary(store.usageEvents || []) });
    }

    const user = currentUser(req, store);
    if (!user) return json(res, 401, { error: 'Unauthorized' });
    const tasks = filterTasks(store.tasks, params, user);

    if (req.method === 'GET' && rawPath === '/tasks') return json(res, 200, tasks);
    if (req.method === 'GET' && rawPath === '/metrics') return json(res, 200, metrics(tasks));
    if (req.method === 'GET' && rawPath === '/report') return json(res, 200, report(tasks));
    if (req.method === 'GET' && rawPath === '/insights') return json(res, 200, insights(report(tasks)));
    if (req.method === 'GET' && rawPath === '/plugins') {
      const state = normalizePluginState(store.pluginState);
      return json(res, 200, AVAILABLE_PLUGINS.map(plugin => ({ id: plugin.id, role: plugin.role, name: plugin.name, description: plugin.description, enabled: state[plugin.id] !== false })));
    }
    if (req.method === 'GET' && rawPath === '/rules') return json(res, 200, store.rules);
    if (req.method === 'GET' && rawPath === '/audit') return json(res, 200, store.audit.slice(0, Number(params.limit) || 50));
    if (req.method === 'GET' && rawPath === '/usage') return json(res, 200, { events: (store.usageEvents || []).slice(0, 200), summary: usageSummary(store.usageEvents || []), monitor: store.monitorStatus || null });
    if (req.method === 'GET' && rawPath === '/users') {
      if (user.role !== 'admin') return json(res, 403, { error: 'admin role required' });
      return json(res, 200, store.users.map(publicUser));
    }
    if (req.method === 'GET' && rawPath === '/export/tasks.csv') {
      logAudit(store, user, 'export_tasks_csv', 'report');
      await writeStore(store);
      return text(res, 200, tasksCsv(tasks), 'text/csv; charset=utf-8', 'ai-workflow-tasks.csv');
    }
    if (req.method === 'GET' && rawPath === '/export/report.csv') {
      logAudit(store, user, 'export_report_csv', 'report');
      await writeStore(store);
      return text(res, 200, reportCsv(report(tasks)), 'text/csv; charset=utf-8', 'ai-workflow-report.csv');
    }
    if (req.method === 'GET' && rawPath === '/export/report.pdf') {
      const rep = report(tasks);
      logAudit(store, user, 'export_report_pdf', 'report');
      await writeStore(store);
      return text(res, 200, reportPdf(rep, insights(rep)), 'application/pdf', 'ai-workflow-report.pdf');
    }

    const pluginMatch = rawPath.match(/^\/plugins\/([^/]+)$/);
    if (pluginMatch && req.method === 'PATCH') {
      if (user.role !== 'admin') return json(res, 403, { error: 'admin role required' });
      const pluginId = decodeURIComponent(pluginMatch[1]);
      if (!AVAILABLE_PLUGINS.some(plugin => plugin.id === pluginId)) return json(res, 404, { error: 'Plugin not found' });
      const body = await readBody(req);
      store.pluginState[pluginId] = Boolean(body.enabled);
      logAudit(store, user, 'update_plugin', 'plugin', pluginId, { enabled: Boolean(body.enabled) });
      await writeStore(store);
      const state = normalizePluginState(store.pluginState);
      return json(res, 200, AVAILABLE_PLUGINS.map(plugin => ({ id: plugin.id, role: plugin.role, name: plugin.name, description: plugin.description, enabled: state[plugin.id] !== false })));
    }

    if (req.method === 'POST' && rawPath === '/tasks') {
      const task = taskFromBody(store, await readBody(req));
      if (!userCanWrite(user, task)) return json(res, 403, { error: 'role cannot create task for this department' });
      store.tasks.unshift(task);
      logAudit(store, user, 'create_task', 'task', task.id, { title: task.title });
      await writeStore(store);
      return json(res, 201, task);
    }

    if (req.method === 'POST' && rawPath === '/import/csv') {
      const body = await readBody(req);
      let imported = 0;
      const errors = [];
      for (const [idx, row] of parseCsv(body.csv).entries()) {
        try {
          const task = taskFromBody(store, { ...row, riskFlags: String(row.riskFlags || '').split(/[;,]/).filter(Boolean), approved: ['true', 'yes', 'да', '1'].includes(String(row.approved).toLowerCase()) });
          if (!userCanWrite(user, task)) throw new Error('role cannot import this department');
          store.tasks.unshift(task);
          imported += 1;
        } catch (err) {
          errors.push(`row ${idx + 2}: ${err.message}`);
        }
      }
      logAudit(store, user, 'import_csv', 'task', null, { imported, errors });
      await writeStore(store);
      return json(res, 200, { imported, errors });
    }

    if (req.method === 'POST' && rawPath === '/usage/import') {
      const body = await readBody(req);
      const importedEvents = parseUsageCsv(String(body.csv || ''));
      store.usageEvents = [...importedEvents, ...(store.usageEvents || [])].slice(0, 2000);
      logAudit(store, user, 'import_usage_csv', 'usage', null, { imported: importedEvents.length });
      await writeStore(store);
      return json(res, 200, { imported: importedEvents.length, summary: usageSummary(store.usageEvents || []) });
    }

    if (req.method === 'POST' && rawPath === '/usage/events') {
      const body = await readBody(req);
      const rawEvents = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : [body]);
      const events = rawEvents.filter(Boolean).map(event => normalizeUsageEvent(event));
      if (!events.length && !body.monitor) return json(res, 400, { error: 'usage events or monitor heartbeat are required' });
      const byId = new Map((store.usageEvents || []).map(event => [event.id, event]));
      for (const event of events) byId.set(event.id, event);
      store.usageEvents = [...events, ...Array.from(byId.values()).filter(event => !events.some(item => item.id === event.id))].slice(0, 2000);
      store.monitorStatus = body.monitor ? monitorStatusFromBody(body, events) : store.monitorStatus || null;
      logAudit(store, user, body.monitor ? 'monitor_heartbeat' : 'import_usage_events', 'usage', null, { imported: events.length, costUsd: events.reduce((sum, event) => sum + event.costUsd, 0), monitor: store.monitorStatus });
      await writeStore(store);
      return json(res, 200, { imported: events.length, events, monitor: store.monitorStatus, summary: usageSummary(store.usageEvents || []) });
    }

    if (req.method === 'POST' && rawPath === '/usage/cli-status') {
      const body = await readBody(req);
      const events = parseCliStatusBlock(body.line || body.status || body.text, { user: body.user || user.username, department: body.department || user.department || '', session: body.session || '' });
      if (!events.length) return json(res, 400, { error: 'Вставьте одну или несколько строк статуса CLI.' });
      store.usageEvents = [...events, ...(store.usageEvents || [])].slice(0, 2000);
      logAudit(store, user, 'import_cli_usage', 'usage', null, { imported: events.length, costUsd: events.reduce((sum, event) => sum + event.costUsd, 0) });
      await writeStore(store);
      return json(res, 200, { imported: events.length, event: events[0], events, summary: usageSummary(store.usageEvents || []) });
    }

    if (req.method === 'POST' && rawPath === '/usage/sync') {
      const result = await syncUsageProviders(store);
      logAudit(store, user, 'sync_usage', 'usage', null, result);
      await writeStore(store);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && rawPath === '/users') {
      if (user.role !== 'admin') return json(res, 403, { error: 'admin role required' });
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      if (!username) return json(res, 400, { error: 'username is required' });
      const existing = store.users.find(item => item.username === username);
      if (!existing && !body.password) return json(res, 400, { error: 'password is required for new user' });
      const saved = {
        username,
        password: body.password || existing.password,
        role: ['admin', 'manager', 'reviewer', 'viewer'].includes(body.role) ? body.role : 'viewer',
        department: String(body.department || ''),
        created_at: existing?.created_at || nowIso()
      };
      if (existing) Object.assign(existing, saved);
      else store.users.push(saved);
      logAudit(store, user, 'upsert_user', 'user', username, { role: saved.role, department: saved.department });
      await writeStore(store);
      return json(res, 200, publicUser(saved));
    }

    const userMatch = rawPath.match(/^\/users\/([^/]+)$/);
    if (userMatch && req.method === 'DELETE') {
      if (user.role !== 'admin') return json(res, 403, { error: 'admin role required' });
      const username = decodeURIComponent(userMatch[1]);
      if (username === 'admin') return json(res, 400, { error: 'admin user cannot be deleted' });
      store.users = store.users.filter(item => item.username !== username);
      logAudit(store, user, 'delete_user', 'user', username);
      await writeStore(store);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rawPath === '/rules') {
      if (user.role !== 'admin') return json(res, 403, { error: 'admin role required' });
      const body = await readBody(req);
      const rule = {
        id: `r_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        name: String(body.name || '').trim(),
        enabled: Boolean(body.enabled ?? true),
        matchText: String(body.matchText || '').trim(),
        matchDepartment: String(body.matchDepartment || '').trim(),
        minRevisions: body.minRevisions === '' || body.minRevisions === undefined ? '' : Number(body.minRevisions),
        maxRoiPercent: body.maxRoiPercent === '' || body.maxRoiPercent === undefined ? '' : Number(body.maxRoiPercent),
        addRisk: String(body.addRisk || '').trim(),
        finding: String(body.finding || '').trim(),
        suggestion: String(body.suggestion || '').trim(),
        createdAt: nowIso()
      };
      if (!rule.name) return json(res, 400, { error: 'rule name is required' });
      store.rules.unshift(rule);
      logAudit(store, user, 'create_rule', 'rule', rule.id, { name: rule.name });
      await writeStore(store);
      return json(res, 201, rule);
    }

    const ruleMatch = rawPath.match(/^\/rules\/([^/]+)$/);
    if (ruleMatch) {
      if (user.role !== 'admin') return json(res, 403, { error: 'admin role required' });
      const id = decodeURIComponent(ruleMatch[1]);
      const idx = store.rules.findIndex(rule => rule.id === id);
      if (idx === -1) return json(res, 404, { error: 'Rule not found' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        store.rules[idx] = { ...store.rules[idx], ...body, id };
        logAudit(store, user, 'update_rule', 'rule', id, { name: store.rules[idx].name });
        await writeStore(store);
        return json(res, 200, store.rules[idx]);
      }
      if (req.method === 'DELETE') {
        store.rules.splice(idx, 1);
        logAudit(store, user, 'delete_rule', 'rule', id);
        await writeStore(store);
        return json(res, 200, { ok: true });
      }
    }

    const taskMatch = rawPath.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const idx = store.tasks.findIndex(task => task.id === id);
      if (idx === -1) return json(res, 404, { error: 'Task not found' });
      if (req.method === 'PUT') {
        if (!userCanWrite(user, store.tasks[idx])) return json(res, 403, { error: 'role cannot update this task' });
        store.tasks[idx] = taskFromBody(store, await readBody(req), store.tasks[idx]);
        logAudit(store, user, 'update_task', 'task', id);
        await writeStore(store);
        return json(res, 200, store.tasks[idx]);
      }
      if (req.method === 'DELETE') {
        if (!userCanWrite(user, store.tasks[idx])) return json(res, 403, { error: 'role cannot delete this task' });
        store.tasks.splice(idx, 1);
        logAudit(store, user, 'delete_task', 'task', id);
        await writeStore(store);
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
};
