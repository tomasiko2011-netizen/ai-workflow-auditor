const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { AVAILABLE_PLUGINS, normalizePluginState, executePlugins } = require('./plugins');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SQLITE_PATH = path.join(DATA_DIR, 'auditor.sqlite');
const LEGACY_STORE_PATH = path.join(DATA_DIR, 'store.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const USAGE_RETENTION_DAYS = Number(process.env.AUDITOR_USAGE_RETENTION_DAYS || 90) || 90;
const INGEST_RATE_LIMIT_PER_MIN = Number(process.env.AUDITOR_INGEST_RATE_LIMIT_PER_MIN || 120) || 120;
let localMonitorStatus = null;
const ingestRate = new Map();

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql, options = {}) {
  ensureDir();
  const args = options.json ? ['-json', SQLITE_PATH, sql] : [SQLITE_PATH, sql];
  const result = spawnSync('sqlite3', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || 'sqlite3 command failed').trim());
  if (!options.json) return [];
  const out = result.stdout.trim();
  return out ? JSON.parse(out) : [];
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (!storedHash.startsWith('scrypt$')) return storedHash === legacyHashPassword(password);
  const [, salt, expected] = storedHash.split('$');
  const actual = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), actual);
}

function nowIso() {
  return new Date().toISOString();
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

function rateLimitIngest(req) {
  const tokenHash = crypto.createHash('sha256').update(bearerToken(req)).digest('hex').slice(0, 16);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const current = ingestRate.get(tokenHash) || { windowStart: now, count: 0 };
  if (now - current.windowStart >= windowMs) {
    current.windowStart = now;
    current.count = 0;
  }
  current.count += 1;
  ingestRate.set(tokenHash, current);
  for (const [key, value] of ingestRate.entries()) {
    if (now - Number(value.windowStart || 0) > windowMs * 10) ingestRate.delete(key);
  }
  return current.count <= INGEST_RATE_LIMIT_PER_MIN;
}

function initDb() {
  runSql(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      title TEXT NOT NULL,
      ai_tool TEXT NOT NULL DEFAULT 'Unknown',
      department TEXT NOT NULL,
      owner TEXT NOT NULL,
      without_ai_minutes INTEGER NOT NULL DEFAULT 0,
      with_ai_minutes INTEGER NOT NULL DEFAULT 0,
      revisions INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      risk_flags_json TEXT NOT NULL DEFAULT '[]',
      plugin_findings_json TEXT NOT NULL DEFAULT '[]',
      plugin_suggestions_json TEXT NOT NULL DEFAULT '[]',
      plugin_applied_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS plugin_state (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      department TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS custom_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      match_text TEXT,
      match_department TEXT,
      min_revisions INTEGER,
      max_roi_percent REAL,
      add_risk TEXT,
      finding TEXT,
      suggestion TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      user_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      provider TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT,
      project TEXT,
      user_label TEXT,
      department TEXT,
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual'
    );
  `);
  try {
    runSql(`ALTER TABLE tasks ADD COLUMN ai_tool TEXT NOT NULL DEFAULT 'Unknown';`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) throw err;
  }

  for (const plugin of AVAILABLE_PLUGINS) {
    runSql(`INSERT OR IGNORE INTO plugin_state (id, enabled) VALUES (${sqlValue(plugin.id)}, 1);`);
  }

  runSql(`
    INSERT INTO users (username, password_hash, role, department, created_at)
    VALUES (${sqlValue('admin')}, ${sqlValue(hashPassword(ADMIN_PASSWORD))}, 'admin', NULL, ${sqlValue(nowIso())})
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = 'admin';
  `);

  const rows = runSql('SELECT COUNT(*) AS count FROM tasks;', { json: true });
  if (Number(rows[0]?.count || 0) === 0 && fs.existsSync(LEGACY_STORE_PATH)) {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STORE_PATH, 'utf8') || '{}');
    const tasks = Array.isArray(legacy.tasks) ? legacy.tasks : [];
    for (const task of tasks.reverse()) saveTask(task);
    const state = normalizePluginState(legacy.pluginState);
    for (const [id, enabled] of Object.entries(state)) setPluginState(id, enabled);
  }
}

function rowToTask(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at || undefined,
    title: row.title,
    aiTool: row.ai_tool || 'Unknown',
    department: row.department,
    owner: row.owner,
    withoutAiMinutes: Number(row.without_ai_minutes) || 0,
    withAiMinutes: Number(row.with_ai_minutes) || 0,
    revisions: Number(row.revisions) || 0,
    approved: Boolean(Number(row.approved)),
    riskFlags: JSON.parse(row.risk_flags_json || '[]'),
    pluginFindings: JSON.parse(row.plugin_findings_json || '[]'),
    pluginSuggestions: JSON.parse(row.plugin_suggestions_json || '[]'),
    pluginApplied: JSON.parse(row.plugin_applied_json || '[]')
  };
}

function taskValues(task) {
  return [
    sqlValue(task.id),
    sqlValue(task.createdAt),
    sqlValue(task.updatedAt || null),
    sqlValue(task.title),
    sqlValue(task.aiTool || 'Unknown'),
    sqlValue(task.department),
    sqlValue(task.owner),
    sqlValue(Number(task.withoutAiMinutes) || 0),
    sqlValue(Number(task.withAiMinutes) || 0),
    sqlValue(Number(task.revisions) || 0),
    sqlValue(task.approved ? 1 : 0),
    sqlValue(JSON.stringify(task.riskFlags || [])),
    sqlValue(JSON.stringify(task.pluginFindings || [])),
    sqlValue(JSON.stringify(task.pluginSuggestions || [])),
    sqlValue(JSON.stringify(task.pluginApplied || []))
  ].join(', ');
}

function getUser(username) {
  const rows = runSql(`SELECT username, password_hash, role, department, created_at FROM users WHERE username = ${sqlValue(username)} LIMIT 1;`, { json: true });
  return rows[0] || null;
}

function listUsers() {
  return runSql('SELECT username, role, department, created_at FROM users ORDER BY username;', { json: true });
}

function publicUserRow(user) {
  return {
    username: user.username,
    role: user.role,
    department: user.department || '',
    created_at: user.created_at
  };
}

function saveUser(user) {
  const username = String(user.username || '').trim();
  const role = ['admin', 'manager', 'reviewer', 'viewer'].includes(user.role) ? user.role : 'viewer';
  if (!username) throw new Error('username is required');
  if (!user.password && !getUser(username)) throw new Error('password is required for new user');
  const existing = getUser(username);
  const passwordHash = user.password ? hashPassword(user.password) : existing.password_hash;
  runSql(`
    INSERT INTO users (username, password_hash, role, department, created_at)
    VALUES (${sqlValue(username)}, ${sqlValue(passwordHash)}, ${sqlValue(role)}, ${sqlValue(user.department || null)}, ${sqlValue(existing?.created_at || nowIso())})
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role,
      department = excluded.department;
  `);
  return publicUserRow(getUser(username));
}

function deleteUser(username) {
  if (username === 'admin') throw new Error('admin user cannot be deleted');
  runSql(`DELETE FROM users WHERE username = ${sqlValue(username)};`);
}

function userCanWrite(user, task = null) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'manager') return !task || !user.department || task.department === user.department;
  return false;
}

function userCanReview(user, task = null) {
  return userCanWrite(user, task) || user?.role === 'reviewer';
}

function filterForUser(params, user) {
  const next = { ...params };
  if (user?.role === 'manager' && user.department) next.department = user.department;
  return next;
}

function getPluginState() {
  const rows = runSql('SELECT id, enabled FROM plugin_state;', { json: true });
  const raw = Object.fromEntries(rows.map(row => [row.id, Number(row.enabled) === 1]));
  return normalizePluginState(raw);
}

function setPluginState(pluginId, enabled) {
  runSql(`
    INSERT INTO plugin_state (id, enabled)
    VALUES (${sqlValue(pluginId)}, ${enabled ? 1 : 0})
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled;
  `);
}

function rowToRule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(Number(row.enabled)),
    matchText: row.match_text || '',
    matchDepartment: row.match_department || '',
    minRevisions: row.min_revisions === null || row.min_revisions === undefined ? '' : Number(row.min_revisions),
    maxRoiPercent: row.max_roi_percent === null || row.max_roi_percent === undefined ? '' : Number(row.max_roi_percent),
    addRisk: row.add_risk || '',
    finding: row.finding || '',
    suggestion: row.suggestion || '',
    createdAt: row.created_at
  };
}

function listRules() {
  return runSql('SELECT * FROM custom_rules ORDER BY created_at DESC;', { json: true }).map(rowToRule);
}

function saveRule(body, existing = {}) {
  const rule = {
    id: existing.id || `r_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    name: String(body.name ?? existing.name ?? '').trim(),
    enabled: Boolean(body.enabled ?? existing.enabled ?? true),
    matchText: String(body.matchText ?? existing.matchText ?? '').trim(),
    matchDepartment: String(body.matchDepartment ?? existing.matchDepartment ?? '').trim(),
    minRevisions: body.minRevisions === '' || body.minRevisions === undefined ? null : Number(body.minRevisions),
    maxRoiPercent: body.maxRoiPercent === '' || body.maxRoiPercent === undefined ? null : Number(body.maxRoiPercent),
    addRisk: String(body.addRisk ?? existing.addRisk ?? '').trim(),
    finding: String(body.finding ?? existing.finding ?? '').trim(),
    suggestion: String(body.suggestion ?? existing.suggestion ?? '').trim(),
    createdAt: existing.createdAt || nowIso()
  };
  if (!rule.name) throw new Error('rule name is required');
  runSql(`
    INSERT INTO custom_rules (
      id, name, enabled, match_text, match_department, min_revisions, max_roi_percent,
      add_risk, finding, suggestion, created_at
    ) VALUES (
      ${sqlValue(rule.id)}, ${sqlValue(rule.name)}, ${rule.enabled ? 1 : 0}, ${sqlValue(rule.matchText || null)},
      ${sqlValue(rule.matchDepartment || null)}, ${sqlValue(rule.minRevisions)}, ${sqlValue(rule.maxRoiPercent)},
      ${sqlValue(rule.addRisk || null)}, ${sqlValue(rule.finding || null)}, ${sqlValue(rule.suggestion || null)}, ${sqlValue(rule.createdAt)}
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      match_text = excluded.match_text,
      match_department = excluded.match_department,
      min_revisions = excluded.min_revisions,
      max_roi_percent = excluded.max_roi_percent,
      add_risk = excluded.add_risk,
      finding = excluded.finding,
      suggestion = excluded.suggestion;
  `);
  return getRule(rule.id);
}

function getRule(id) {
  const rows = runSql(`SELECT * FROM custom_rules WHERE id = ${sqlValue(id)} LIMIT 1;`, { json: true });
  return rows[0] ? rowToRule(rows[0]) : null;
}

function deleteRule(id) {
  runSql(`DELETE FROM custom_rules WHERE id = ${sqlValue(id)};`);
}

function applyCustomRules(task, pluginResult) {
  const risks = [...pluginResult.riskFlags];
  const findings = [...pluginResult.pluginFindings];
  const suggestions = [...pluginResult.pluginSuggestions];
  const applied = [...pluginResult.pluginApplied];
  const joined = `${task.title} ${(task.riskFlags || []).join(' ')}`.toLowerCase();
  const saved = Math.max(task.withoutAiMinutes - task.withAiMinutes, 0);
  const roiPercent = task.withoutAiMinutes ? saved / task.withoutAiMinutes * 100 : 0;

  for (const rule of listRules().filter(item => item.enabled)) {
    const matchesText = !rule.matchText || joined.includes(rule.matchText.toLowerCase());
    const matchesDepartment = !rule.matchDepartment || task.department === rule.matchDepartment;
    const matchesRevisions = rule.minRevisions === '' || Number(task.revisions) >= Number(rule.minRevisions);
    const matchesRoi = rule.maxRoiPercent === '' || roiPercent <= Number(rule.maxRoiPercent);
    if (!matchesText || !matchesDepartment || !matchesRevisions || !matchesRoi) continue;

    if (rule.addRisk && !risks.includes(rule.addRisk)) risks.push(rule.addRisk);
    if (rule.finding) findings.push({ pluginId: `rule:${rule.id}`, text: rule.finding });
    if (rule.suggestion) suggestions.push({ pluginId: `rule:${rule.id}`, text: rule.suggestion });
    applied.push(`rule:${rule.name}`);
  }

  return { riskFlags: risks, pluginFindings: findings, pluginSuggestions: suggestions, pluginApplied: applied };
}

function buildTaskWhere(params) {
  const clauses = [];
  if (params.department) clauses.push(`department = ${sqlValue(params.department)}`);
  if (params.aiTool) clauses.push(`ai_tool = ${sqlValue(params.aiTool)}`);
  if (params.owner) clauses.push(`LOWER(owner) LIKE LOWER(${sqlValue(`%${params.owner}%`)})`);
  if (params.approved === 'true') clauses.push('approved = 1');
  if (params.approved === 'false') clauses.push('approved = 0');
  if (params.risk) clauses.push(`risk_flags_json LIKE ${sqlValue(`%"${params.risk}"%`)}`);
  if (params.from) clauses.push(`date(created_at) >= date(${sqlValue(params.from)})`);
  if (params.to) clauses.push(`date(created_at) <= date(${sqlValue(params.to)})`);
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function listTasks(params = {}, user = null) {
  const where = buildTaskWhere(filterForUser(params, user));
  const rows = runSql(`SELECT * FROM tasks ${where} ORDER BY datetime(created_at) DESC;`, { json: true });
  return rows.map(rowToTask);
}

function getTask(id) {
  const rows = runSql(`SELECT * FROM tasks WHERE id = ${sqlValue(id)} LIMIT 1;`, { json: true });
  return rows[0] ? rowToTask(rows[0]) : null;
}

function saveTask(task) {
  runSql(`
    INSERT INTO tasks (
      id, created_at, updated_at, title, ai_tool, department, owner, without_ai_minutes,
      with_ai_minutes, revisions, approved, risk_flags_json, plugin_findings_json,
      plugin_suggestions_json, plugin_applied_json
    ) VALUES (${taskValues(task)})
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      title = excluded.title,
      ai_tool = excluded.ai_tool,
      department = excluded.department,
      owner = excluded.owner,
      without_ai_minutes = excluded.without_ai_minutes,
      with_ai_minutes = excluded.with_ai_minutes,
      revisions = excluded.revisions,
      approved = excluded.approved,
      risk_flags_json = excluded.risk_flags_json,
      plugin_findings_json = excluded.plugin_findings_json,
      plugin_suggestions_json = excluded.plugin_suggestions_json,
      plugin_applied_json = excluded.plugin_applied_json;
  `);
}

function deleteTask(id) {
  runSql(`DELETE FROM tasks WHERE id = ${sqlValue(id)};`);
}

function taskFromBody(body, existing = {}) {
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
    riskFlags: Array.isArray(body.riskFlags)
      ? body.riskFlags.map(String).map(v => v.trim()).filter(Boolean)
      : existing.riskFlags || []
  };

  if (!baseTask.title || !baseTask.department || !baseTask.owner) {
    throw new Error('title, department, owner are required');
  }

  const builtIn = executePlugins(baseTask, getPluginState());
  return { ...baseTask, ...applyCustomRules(baseTask, builtIn) };
}

function buildMetrics(tasks) {
  const total = tasks.length;
  const totalBefore = tasks.reduce((acc, t) => acc + (Number(t.withoutAiMinutes) || 0), 0);
  const totalAfter = tasks.reduce((acc, t) => acc + (Number(t.withAiMinutes) || 0), 0);
  const savedMinutes = Math.max(totalBefore - totalAfter, 0);
  const approvedCount = tasks.filter(t => t.approved === true).length;
  const revisionsTotal = tasks.reduce((acc, t) => acc + (Number(t.revisions) || 0), 0);
  const riskCounters = {};
  const pluginUsage = {};

  for (const task of tasks) {
    for (const flag of task.riskFlags || []) riskCounters[flag] = (riskCounters[flag] || 0) + 1;
    for (const pluginId of task.pluginApplied || []) pluginUsage[pluginId] = (pluginUsage[pluginId] || 0) + 1;
  }

  return {
    totalTasks: total,
    totalBeforeMinutes: totalBefore,
    totalAfterMinutes: totalAfter,
    savedMinutes,
    savedHours: +(savedMinutes / 60).toFixed(2),
    approvalRate: total ? +(approvedCount / total * 100).toFixed(1) : 0,
    revisionsAvg: total ? +(revisionsTotal / total).toFixed(2) : 0,
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

function rowToUsageEvent(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    provider: row.provider,
    tool: row.tool,
    model: row.model || '',
    project: row.project || '',
    user: row.user_label || '',
    department: row.department || '',
    requests: Number(row.requests) || 0,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    totalTokens: Number(row.total_tokens) || 0,
    costUsd: Number(row.cost_usd) || 0,
    source: row.source || 'manual'
  };
}

function saveUsageEvent(input) {
  const event = normalizeUsageEvent(input);
  runSql(`
    INSERT INTO usage_events (
      id, created_at, period_start, period_end, provider, tool, model, project, user_label,
      department, requests, input_tokens, output_tokens, total_tokens, cost_usd, source
    ) VALUES (
      ${sqlValue(event.id)}, ${sqlValue(event.createdAt)}, ${sqlValue(event.periodStart)}, ${sqlValue(event.periodEnd)},
      ${sqlValue(event.provider)}, ${sqlValue(event.tool)}, ${sqlValue(event.model || null)}, ${sqlValue(event.project || null)},
      ${sqlValue(event.user || null)}, ${sqlValue(event.department || null)}, ${sqlValue(event.requests)},
      ${sqlValue(event.inputTokens)}, ${sqlValue(event.outputTokens)}, ${sqlValue(event.totalTokens)},
      ${sqlValue(event.costUsd)}, ${sqlValue(event.source)}
    ) ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      provider = excluded.provider,
      tool = excluded.tool,
      model = excluded.model,
      project = excluded.project,
      user_label = excluded.user_label,
      department = excluded.department,
      requests = excluded.requests,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      source = excluded.source;
  `);
  return event;
}

function cleanupUsageEvents() {
  const cutoff = new Date(Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  runSql(`DELETE FROM usage_events WHERE datetime(period_start) < datetime(${sqlValue(cutoff)});`);
}

function listUsageEvents(limit = 200) {
  cleanupUsageEvents();
  return runSql(`SELECT * FROM usage_events ORDER BY datetime(period_start) DESC, datetime(created_at) DESC LIMIT ${Math.min(Number(limit) || 200, 1000)};`, { json: true }).map(rowToUsageEvent);
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
  const dayKey = event => String(event.periodStart || event.createdAt || '').slice(0, 10) || 'unknown';
  const monthKey = event => dayKey(event).slice(0, 7) || 'unknown';
  const weekKey = event => {
    const date = new Date(`${dayKey(event)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return 'unknown';
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  const sessionKey = event => String(event.project || '').split(' / ')[0].replace(/^окно\s+/, '').trim() || event.project || 'unknown';
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
  const byDay = Object.values(events.reduce((acc, event) => {
    const label = dayKey(event);
    acc[label] ||= { label, events: 0, costUsd: 0, tokens: 0, requests: 0 };
    acc[label].events += 1;
    acc[label].costUsd += Number(event.costUsd) || 0;
    acc[label].tokens += Number(event.totalTokens) || 0;
    acc[label].requests += Number(event.requests) || 0;
    return acc;
  }, {})).map(row => ({ ...row, costUsd: +row.costUsd.toFixed(4) })).sort((a, b) => a.label.localeCompare(b.label));
  const rollup = keyFn => Object.values(events.reduce((acc, event) => {
    const label = keyFn(event);
    acc[label] ||= { label, events: 0, costUsd: 0, tokens: 0, requests: 0 };
    acc[label].events += 1;
    acc[label].costUsd += Number(event.costUsd) || 0;
    acc[label].tokens += Number(event.totalTokens) || 0;
    acc[label].requests += Number(event.requests) || 0;
    return acc;
  }, {})).map(row => ({ ...row, costUsd: +row.costUsd.toFixed(4) })).sort((a, b) => a.label.localeCompare(b.label));
  const bySession = Object.values(events.reduce((acc, event) => {
    const session = sessionKey(event);
    acc[session] ||= { session, project: event.project || '', source: event.source || '', events: 0, costUsd: 0, tokens: 0, requests: 0, lastSeenAt: '' };
    acc[session].events += 1;
    acc[session].costUsd += Number(event.costUsd) || 0;
    acc[session].tokens += Number(event.totalTokens) || 0;
    acc[session].requests += Number(event.requests) || 0;
    acc[session].lastSeenAt = [acc[session].lastSeenAt, event.periodEnd || event.createdAt || ''].sort().at(-1) || '';
    return acc;
  }, {})).map(row => ({ ...row, costUsd: +row.costUsd.toFixed(4) })).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
  return { totalEvents: events.length, totalCostUsd: +totalCostUsd.toFixed(4), totalTokens, totalRequests, byProvider: group('provider'), byTool: group('tool'), byModel: group('model'), byProject: group('project'), bySource: group('source'), byDay, byWeek: rollup(weekKey), byMonth: rollup(monthKey), byUser, userToolRows, bySession, lastUpdated: events[0]?.createdAt || null };
}

function filterUsageEvents(events = [], params = {}) {
  const source = params.source || params.usageSource || '';
  return events.filter(event => {
    if (source && event.source !== source) return false;
    if (params.provider && event.provider !== params.provider) return false;
    if (params.tool && event.tool !== params.tool) return false;
    if (params.user && event.user !== params.user) return false;
    if (params.project && !String(event.project || '').toLowerCase().includes(String(params.project).toLowerCase())) return false;
    if (params.from && new Date(event.periodStart || event.createdAt) < new Date(params.from)) return false;
    if (params.to && new Date(event.periodStart || event.createdAt) > new Date(`${params.to}T23:59:59`)) return false;
    return true;
  }).sort((a, b) => new Date(b.periodStart || b.createdAt) - new Date(a.periodStart || a.createdAt));
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

function parseUsageCsv(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map(row => {
    const record = Object.fromEntries(headers.map((header, i) => [header, row[i] || '']));
    return normalizeUsageEvent(record);
  });
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
    source: 'claude-cli-status'
  });
}

function parseCliStatusBlock(text, defaults = {}) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => parseCliStatusLine(line, defaults));
}

async function syncUsageProviders() {
  const results = [];
  if (!process.env.OPENAI_ADMIN_KEY) {
    results.push({ provider: 'openai', status: 'missing_key', message: 'OPENAI_ADMIN_KEY не задан' });
  } else {
    results.push({ provider: 'openai', status: 'configured', message: 'Ключ найден; production serverless sync использует Costs API' });
  }
  if (!process.env.ANTHROPIC_ADMIN_KEY) {
    results.push({ provider: 'anthropic', status: 'missing_key', message: 'ANTHROPIC_ADMIN_KEY не задан' });
  } else {
    results.push({ provider: 'anthropic', status: 'configured', message: 'Ключ найден; готово к подключению Usage/Cost API' });
  }
  return { results, summary: usageSummary(listUsageEvents(1000)) };
}

function groupBy(tasks, key) {
  const rows = {};
  for (const task of tasks) {
    const label = task[key] || 'unknown';
    if (!rows[label]) rows[label] = { label, tasks: 0, savedMinutes: 0, approved: 0, revisions: 0 };
    rows[label].tasks += 1;
    rows[label].savedMinutes += Math.max(task.withoutAiMinutes - task.withAiMinutes, 0);
    rows[label].approved += task.approved ? 1 : 0;
    rows[label].revisions += task.revisions;
  }
  return Object.values(rows)
    .map(row => ({
      ...row,
      savedHours: +(row.savedMinutes / 60).toFixed(2),
      approvalRate: row.tasks ? +(row.approved / row.tasks * 100).toFixed(1) : 0,
      revisionsAvg: row.tasks ? +(row.revisions / row.tasks).toFixed(2) : 0
    }))
    .sort((a, b) => b.savedMinutes - a.savedMinutes);
}

function buildReport(tasks) {
  const lowRoiTasks = tasks
    .map(task => {
      const savedMinutes = Math.max(task.withoutAiMinutes - task.withAiMinutes, 0);
      return {
        id: task.id,
        title: task.title,
        owner: task.owner,
        department: task.department,
        savedMinutes,
        roiPercent: task.withoutAiMinutes ? +(savedMinutes / task.withoutAiMinutes * 100).toFixed(1) : 0,
        revisions: task.revisions
      };
    })
    .filter(task => task.roiPercent < 20 || task.revisions >= 3)
    .sort((a, b) => a.roiPercent - b.roiPercent || b.revisions - a.revisions)
    .slice(0, 8);

  return {
    generatedAt: nowIso(),
    metrics: buildMetrics(tasks),
    byDepartment: groupBy(tasks, 'department'),
    byTool: groupBy(tasks, 'aiTool'),
    byOwner: groupBy(tasks, 'owner'),
    lowRoiTasks
  };
}

function buildInsights(report) {
  const insights = [];
  const bestDepartment = report.byDepartment[0];
  const bestTool = report.byTool[0];
  const weakDepartment = [...report.byDepartment].sort((a, b) => a.approvalRate - b.approvalRate)[0];
  if (report.metrics.totalTasks === 0) {
    insights.push({ level: 'info', text: 'Данных пока мало: импортируйте историю или заведите первые AI-задачи.' });
    return insights;
  }
  if (bestDepartment) {
    insights.push({ level: 'positive', text: `${bestDepartment.label}: лидер по экономии, ${bestDepartment.savedHours} ч на ${bestDepartment.tasks} задач.` });
  }
  if (bestTool) {
    insights.push({ level: 'positive', text: `${bestTool.label}: самый полезный AI-инструмент по экономии, ${bestTool.savedHours} ч.` });
  }
  if (weakDepartment && weakDepartment.approvalRate < 70) {
    insights.push({ level: 'warning', text: `${weakDepartment.label}: доля одобренных задач ${weakDepartment.approvalRate}%. Нужен ревью промптов и критериев качества.` });
  }
  if (report.lowRoiTasks.length) {
    insights.push({ level: 'warning', text: `${report.lowRoiTasks.length} задач требуют внимания из-за низкого ROI или большого числа правок.` });
  }
  if (report.metrics.revisionsAvg <= 1 && report.metrics.approvalRate >= 80) {
    insights.push({ level: 'positive', text: 'Качество стабильное: мало правок и высокая доля одобренных задач.' });
  }
  const topRisk = Object.entries(report.metrics.riskCounters).sort((a, b) => b[1] - a[1])[0];
  if (topRisk) {
    insights.push({ level: 'info', text: `Самый частый риск: ${topRisk[0]} (${topRisk[1]} раз). Стоит закрепить отдельный чек-лист.` });
  }
  return insights.slice(0, 5);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '');
}

function taskFromCsvRecord(record) {
  const get = (...keys) => keys.map(key => record[normalizeHeader(key)]).find(value => value !== undefined) || '';
  return {
    title: get('title', 'название', 'task'),
    department: get('department', 'отдел'),
    aiTool: get('aiTool', 'tool', 'ai tool', 'инструмент') || 'Unknown',
    owner: get('owner', 'владелец'),
    withoutAiMinutes: Number(get('withoutAiMinutes', 'without_ai_minutes', 'минут без ai', 'до ai')) || 0,
    withAiMinutes: Number(get('withAiMinutes', 'with_ai_minutes', 'минут с ai', 'с ai')) || 0,
    revisions: Number(get('revisions', 'правки')) || 0,
    approved: ['true', 'yes', 'да', '1', 'approved'].includes(String(get('approved', 'одобрено', 'status')).trim().toLowerCase()),
    riskFlags: String(get('riskFlags', 'risks', 'риски')).split(/[;,]/).map(v => v.trim()).filter(Boolean)
  };
}

function importCsv(csv, user) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { imported: 0, errors: ['CSV must include header and at least one row'] };
  const headers = rows[0].map(normalizeHeader);
  const errors = [];
  let imported = 0;
  for (const [idx, row] of rows.slice(1).entries()) {
    try {
      const record = Object.fromEntries(headers.map((header, i) => [header, row[i] || '']));
      const task = taskFromBody(taskFromCsvRecord(record));
      if (!userCanWrite(user, task)) throw new Error('role cannot import this department');
      saveTask(task);
      imported += 1;
    } catch (err) {
      errors.push(`row ${idx + 2}: ${err.message}`);
    }
  }
  return { imported, errors };
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function tasksCsv(tasks) {
  const rows = [
    ['id', 'createdAt', 'title', 'aiTool', 'department', 'owner', 'withoutAiMinutes', 'withAiMinutes', 'savedMinutes', 'revisions', 'approved', 'riskFlags', 'pluginApplied'],
    ...tasks.map(task => [
      task.id,
      task.createdAt,
      task.title,
      task.aiTool,
      task.department,
      task.owner,
      task.withoutAiMinutes,
      task.withAiMinutes,
      Math.max(task.withoutAiMinutes - task.withAiMinutes, 0),
      task.revisions,
      task.approved,
      task.riskFlags,
      task.pluginApplied
    ])
  ];
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

function reportCsv(report) {
  const rows = [['section', 'label', 'tasks', 'savedHours', 'approvalRate', 'revisionsAvg']];
  for (const row of report.byDepartment) rows.push(['department', row.label, row.tasks, row.savedHours, row.approvalRate, row.revisionsAvg]);
  for (const row of report.byTool) rows.push(['tool', row.label, row.tasks, row.savedHours, row.approvalRate, row.revisionsAvg]);
  for (const row of report.byOwner) rows.push(['owner', row.label, row.tasks, row.savedHours, row.approvalRate, row.revisionsAvg]);
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

function usageCsv(events) {
  const rows = [['id', 'createdAt', 'periodStart', 'periodEnd', 'provider', 'tool', 'model', 'project', 'user', 'department', 'requests', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'source']];
  for (const event of events) {
    rows.push([event.id, event.createdAt, event.periodStart, event.periodEnd, event.provider, event.tool, event.model, event.project, event.user, event.department, event.requests, event.inputTokens, event.outputTokens, event.totalTokens, event.costUsd, event.source]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

function pdfText(value) {
  return String(value ?? '').replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?');
}

function makeSimplePdf(lines) {
  const content = ['BT', '/F1 12 Tf', '50 790 Td'];
  for (const [idx, line] of lines.entries()) {
    if (idx > 0) content.push('0 -18 Td');
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
  return Buffer.from(pdf, 'binary');
}

function reportPdf(report, insights) {
  const lines = [
    'Отчёт аудитора AI-процессов',
    `Сформирован: ${report.generatedAt}`,
    `Задач: ${report.metrics.totalTasks}`,
    `Сэкономлено часов: ${report.metrics.savedHours}`,
    `Одобрено: ${report.metrics.approvalRate}%`,
    `Среднее правок: ${report.metrics.revisionsAvg}`,
    '',
    'По AI-инструментам:'
  ];
  for (const row of report.byTool) lines.push(`${row.label}: ${row.savedHours} ч экономии, задач ${row.tasks}, одобрено ${row.approvalRate}%`);
  lines.push('', 'По отделам:');
  for (const row of report.byDepartment) lines.push(`${row.label}: ${row.savedHours} ч экономии, задач ${row.tasks}, одобрено ${row.approvalRate}%`);
  lines.push('', 'Инсайты:');
  for (const item of insights) lines.push(`- ${item.text}`);
  return makeSimplePdf(lines);
}

function usagePdf(events) {
  const summary = usageSummary(events);
  const lines = [
    'Usage report',
    `Generated: ${nowIso()}`,
    `Events: ${summary.totalEvents}`,
    `Cost USD: ${summary.totalCostUsd}`,
    `Tokens: ${summary.totalTokens}`,
    `Requests: ${summary.totalRequests}`,
    '',
    'Models:'
  ];
  for (const row of (summary.byModel || []).slice(0, 8)) lines.push(`${row.label}: $${row.costUsd}, ${row.tokens} tokens, ${row.requests} requests`);
  lines.push('', 'Sources:');
  for (const row of (summary.bySource || []).slice(0, 8)) lines.push(`${row.label}: $${row.costUsd}, ${row.events} events`);
  lines.push('', 'Sessions:');
  for (const row of (summary.bySession || []).slice(0, 8)) lines.push(`${row.session}: $${row.costUsd}, ${row.tokens} tokens`);
  return makeSimplePdf(lines);
}

function listAudit(params = {}) {
  const limit = Math.min(Number(params.limit) || 50, 200);
  return runSql(`SELECT * FROM audit_log ORDER BY datetime(created_at) DESC LIMIT ${limit};`, { json: true })
    .map(row => ({ ...row, details: JSON.parse(row.details_json || '{}'), details_json: undefined }));
}

function logAudit(user, action, targetType, targetId, details = {}) {
  const actor = user?.username || 'system';
  const role = user?.role || 'system';
  runSql(`
    INSERT INTO audit_log (id, created_at, actor, role, action, target_type, target_id, details_json)
    VALUES (
      ${sqlValue(`a_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`)},
      ${sqlValue(nowIso())},
      ${sqlValue(actor)},
      ${sqlValue(role)},
      ${sqlValue(action)},
      ${sqlValue(targetType)},
      ${sqlValue(targetId || null)},
      ${sqlValue(JSON.stringify(details))}
    );
  `);
}

function parseTaskRoute(urlPath) {
  const match = /^\/api\/tasks\/([^/]+)$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseReviewRoute(urlPath) {
  const match = /^\/api\/tasks\/([^/]+)\/review$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function parsePluginRoute(urlPath) {
  const match = /^\/api\/plugins\/([^/]+)$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseUserRoute(urlPath) {
  const match = /^\/api\/users\/([^/]+)$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseRuleRoute(urlPath) {
  const match = /^\/api\/rules\/([^/]+)$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function sendJson(res, code, payload, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

function sendText(res, code, text, contentType, headers = {}) {
  res.writeHead(code, { 'Content-Type': contentType, ...headers });
  res.end(text);
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5e6) {
        reject(new Error('Body too large'));
        req.socket.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
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

function makeSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  runSql(`
    INSERT INTO sessions (token, username, user_json, expires_at)
    VALUES (${sqlValue(token)}, ${sqlValue(user.username)}, ${sqlValue(JSON.stringify(user))}, ${Date.now() + SESSION_TTL_MS});
  `);
  return token;
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).auditor_session;
  if (!token) return null;
  const rows = runSql(`SELECT user_json, expires_at FROM sessions WHERE token = ${sqlValue(token)} LIMIT 1;`, { json: true });
  const session = rows[0];
  if (!session || Number(session.expires_at) < Date.now()) {
    runSql(`DELETE FROM sessions WHERE token = ${sqlValue(token)};`);
    return null;
  }
  runSql(`UPDATE sessions SET expires_at = ${Date.now() + SESSION_TTL_MS} WHERE token = ${sqlValue(token)};`);
  return JSON.parse(session.user_json);
}

function clearSession(req) {
  const token = parseCookies(req.headers.cookie).auditor_session;
  if (token) runSql(`DELETE FROM sessions WHERE token = ${sqlValue(token)};`);
}

function requireAdmin(user) {
  if (user?.role !== 'admin') throw new Error('admin role required');
}

function pluginPayload() {
  const state = getPluginState();
  return AVAILABLE_PLUGINS.map(plugin => ({
    id: plugin.id,
    role: plugin.role,
    name: plugin.name,
    description: plugin.description,
    enabled: state[plugin.id] !== false
  }));
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8'
    }[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function queryParams(urlObj) {
  return Object.fromEntries(urlObj.searchParams.entries());
}

function safeEndpoint(handler) {
  return async (req, res, user, urlObj) => {
    try {
      await handler(req, res, user, urlObj);
    } catch (err) {
      sendJson(res, err.message.includes('required') ? 403 : 400, { error: err.message });
    }
  };
}

initDb();

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    const user = currentUser(req);
    return sendJson(res, 200, { authenticated: Boolean(user), user });
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    try {
      const body = await getBody(req);
      const username = String(body.username || 'admin').trim();
      const user = getUser(username);
      if (!user || !verifyPassword(body.password || '', user.password_hash)) {
        return sendJson(res, 401, { error: 'Invalid username or password' });
      }
      if (!user.password_hash.startsWith('scrypt$')) {
        runSql(`UPDATE users SET password_hash = ${sqlValue(hashPassword(body.password || ''))} WHERE username = ${sqlValue(username)};`);
      }
      const publicUser = { username: user.username, role: user.role, department: user.department || '' };
      const token = makeSession(publicUser);
      logAudit(publicUser, 'login', 'session', username);
      return sendJson(res, 200, { authenticated: true, user: publicUser }, {
        'Set-Cookie': `auditor_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const user = currentUser(req);
    if (user) logAudit(user, 'logout', 'session', user.username);
    clearSession(req);
    return sendJson(res, 200, { authenticated: false }, {
      'Set-Cookie': 'auditor_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
    });
  }

  if (req.method === 'POST' && pathname === '/api/usage/events' && validIngestToken(req)) {
    return safeEndpoint(async () => {
      if (!rateLimitIngest(req)) return sendJson(res, 429, { error: 'Too many usage ingests; slow down the local monitor.' });
      const body = await getBody(req);
      const rawEvents = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : []);
      const events = rawEvents.filter(Boolean).map(saveUsageEvent);
      localMonitorStatus = monitorStatusFromBody(body, events);
      logAudit({ username: 'usage-monitor', role: 'system', department: '' }, 'monitor_heartbeat', 'usage', null, localMonitorStatus);
      return sendJson(res, 200, { imported: events.length, events, monitor: localMonitorStatus, summary: usageSummary(listUsageEvents(1000)) });
    })(req, res, { username: 'usage-monitor', role: 'system', department: '' }, urlObj);
  }

  const user = currentUser(req);
  if (pathname.startsWith('/api/') && !user) return sendJson(res, 401, { error: 'Unauthorized' });

  if (req.method === 'GET' && pathname === '/api/tasks') {
    return sendJson(res, 200, listTasks(queryParams(urlObj), user));
  }

  if (req.method === 'GET' && pathname === '/api/plugins') return sendJson(res, 200, pluginPayload());
  if (req.method === 'GET' && pathname === '/api/rules') return sendJson(res, 200, listRules());
  if (req.method === 'GET' && pathname === '/api/audit') return sendJson(res, 200, listAudit(queryParams(urlObj)));
  if (req.method === 'GET' && pathname === '/api/usage') {
    const usageEvents = filterUsageEvents(listUsageEvents(1000), queryParams(urlObj));
    return sendJson(res, 200, { events: usageEvents.slice(0, 200), summary: usageSummary(usageEvents), monitor: localMonitorStatus });
  }
  if (req.method === 'GET' && pathname === '/api/users') {
    try {
      requireAdmin(user);
      return sendJson(res, 200, listUsers());
    } catch (err) {
      return sendJson(res, 403, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/metrics') {
    return sendJson(res, 200, buildMetrics(listTasks(queryParams(urlObj), user)));
  }

  if (req.method === 'GET' && pathname === '/api/report') {
    return sendJson(res, 200, buildReport(listTasks(queryParams(urlObj), user)));
  }

  if (req.method === 'GET' && pathname === '/api/insights') {
    return sendJson(res, 200, buildInsights(buildReport(listTasks(queryParams(urlObj), user))));
  }

  if (req.method === 'GET' && pathname === '/api/export/tasks.csv') {
    const csv = tasksCsv(listTasks(queryParams(urlObj), user));
    logAudit(user, 'export_tasks_csv', 'report', null);
    return sendText(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="ai-workflow-tasks.csv"' });
  }

  if (req.method === 'GET' && pathname === '/api/export/report.csv') {
    const csv = reportCsv(buildReport(listTasks(queryParams(urlObj), user)));
    logAudit(user, 'export_report_csv', 'report', null);
    return sendText(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="ai-workflow-report.csv"' });
  }

  if (req.method === 'GET' && pathname === '/api/export/report.pdf') {
    const report = buildReport(listTasks(queryParams(urlObj), user));
    const pdf = reportPdf(report, buildInsights(report));
    logAudit(user, 'export_report_pdf', 'report', null);
    return sendText(res, 200, pdf, 'application/pdf', { 'Content-Disposition': 'attachment; filename="ai-workflow-report.pdf"' });
  }

  if (req.method === 'GET' && pathname === '/api/export/usage.csv') {
    const csv = usageCsv(filterUsageEvents(listUsageEvents(1000), queryParams(urlObj)));
    logAudit(user, 'export_usage_csv', 'usage', null);
    return sendText(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="ai-workflow-usage.csv"' });
  }

  if (req.method === 'GET' && pathname === '/api/export/usage.pdf') {
    const pdf = usagePdf(filterUsageEvents(listUsageEvents(1000), queryParams(urlObj)));
    logAudit(user, 'export_usage_pdf', 'usage', null);
    return sendText(res, 200, pdf, 'application/pdf', { 'Content-Disposition': 'attachment; filename="ai-workflow-usage.pdf"' });
  }

  const pluginId = parsePluginRoute(pathname);
  if (req.method === 'PATCH' && pluginId) return safeEndpoint(async () => {
    requireAdmin(user);
    if (!AVAILABLE_PLUGINS.some(plugin => plugin.id === pluginId)) return sendJson(res, 404, { error: 'Plugin not found' });
    const body = await getBody(req);
    setPluginState(pluginId, Boolean(body.enabled));
    logAudit(user, 'update_plugin', 'plugin', pluginId, { enabled: Boolean(body.enabled) });
    return sendJson(res, 200, pluginPayload());
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/tasks') return safeEndpoint(async () => {
    const body = await getBody(req);
    const task = taskFromBody(body);
    if (!userCanWrite(user, task)) return sendJson(res, 403, { error: 'role cannot create task for this department' });
    saveTask(task);
    logAudit(user, 'create_task', 'task', task.id, { title: task.title });
    return sendJson(res, 201, task);
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/import/csv') return safeEndpoint(async () => {
    const body = await getBody(req);
    const result = importCsv(String(body.csv || ''), user);
    logAudit(user, 'import_csv', 'task', null, result);
    return sendJson(res, 200, result);
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/usage/import') return safeEndpoint(async () => {
    const body = await getBody(req);
    const events = parseUsageCsv(String(body.csv || ''));
    for (const event of events) saveUsageEvent(event);
    const result = { imported: events.length, summary: usageSummary(listUsageEvents(1000)) };
    logAudit(user, 'import_usage_csv', 'usage', null, result);
    return sendJson(res, 200, result);
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/usage/events') return safeEndpoint(async () => {
    const body = await getBody(req);
    const rawEvents = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : [body]);
    const events = rawEvents.filter(Boolean).map(saveUsageEvent);
    if (!events.length && !body.monitor) return sendJson(res, 400, { error: 'usage events or monitor heartbeat are required' });
    if (body.monitor) localMonitorStatus = monitorStatusFromBody(body, events);
    const result = { imported: events.length, events, monitor: localMonitorStatus, summary: usageSummary(listUsageEvents(1000)) };
    logAudit(user, body.monitor ? 'monitor_heartbeat' : 'import_usage_events', 'usage', null, { imported: events.length, costUsd: events.reduce((sum, event) => sum + event.costUsd, 0), monitor: localMonitorStatus });
    return sendJson(res, 200, result);
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/usage/cli-status') return safeEndpoint(async () => {
    const body = await getBody(req);
    const events = parseCliStatusBlock(body.line || body.status || body.text, { user: body.user || user.username, department: body.department || user.department || '', session: body.session || '' }).map(saveUsageEvent);
    if (!events.length) return sendJson(res, 400, { error: 'Вставьте одну или несколько строк статуса CLI.' });
    const result = { imported: events.length, event: events[0], events, summary: usageSummary(listUsageEvents(1000)) };
    logAudit(user, 'import_cli_usage', 'usage', null, { imported: events.length, costUsd: events.reduce((sum, event) => sum + event.costUsd, 0) });
    return sendJson(res, 200, result);
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/usage/sync') return safeEndpoint(async () => {
    const result = await syncUsageProviders();
    logAudit(user, 'sync_usage', 'usage', null, result);
    return sendJson(res, 200, result);
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/users') return safeEndpoint(async () => {
    requireAdmin(user);
    const created = saveUser(await getBody(req));
    logAudit(user, 'upsert_user', 'user', created.username, { role: created.role, department: created.department });
    return sendJson(res, 200, created);
  })(req, res, user, urlObj);

  const username = parseUserRoute(pathname);
  if (username && req.method === 'DELETE') return safeEndpoint(async () => {
    requireAdmin(user);
    deleteUser(username);
    logAudit(user, 'delete_user', 'user', username);
    return sendJson(res, 200, { ok: true });
  })(req, res, user, urlObj);

  if (req.method === 'POST' && pathname === '/api/rules') return safeEndpoint(async () => {
    requireAdmin(user);
    const rule = saveRule(await getBody(req));
    logAudit(user, 'create_rule', 'rule', rule.id, { name: rule.name });
    return sendJson(res, 201, rule);
  })(req, res, user, urlObj);

  const ruleId = parseRuleRoute(pathname);
  if (ruleId && req.method === 'PUT') return safeEndpoint(async () => {
    requireAdmin(user);
    const existing = getRule(ruleId);
    if (!existing) return sendJson(res, 404, { error: 'Rule not found' });
    const rule = saveRule(await getBody(req), existing);
    logAudit(user, 'update_rule', 'rule', rule.id, { name: rule.name });
    return sendJson(res, 200, rule);
  })(req, res, user, urlObj);

  if (ruleId && req.method === 'DELETE') return safeEndpoint(async () => {
    requireAdmin(user);
    deleteRule(ruleId);
    logAudit(user, 'delete_rule', 'rule', ruleId);
    return sendJson(res, 200, { ok: true });
  })(req, res, user, urlObj);

  const taskId = parseTaskRoute(pathname);
  if (taskId && req.method === 'PUT') return safeEndpoint(async () => {
    const existing = getTask(taskId);
    if (!existing) return sendJson(res, 404, { error: 'Task not found' });
    if (!userCanWrite(user, existing)) return sendJson(res, 403, { error: 'role cannot update this task' });
    const task = taskFromBody(await getBody(req), existing);
    saveTask(task);
    logAudit(user, 'update_task', 'task', task.id, { title: task.title });
    return sendJson(res, 200, task);
  })(req, res, user, urlObj);

  if (taskId && req.method === 'DELETE') return safeEndpoint(async () => {
    const existing = getTask(taskId);
    if (!existing) return sendJson(res, 404, { error: 'Task not found' });
    if (!userCanWrite(user, existing)) return sendJson(res, 403, { error: 'role cannot delete this task' });
    deleteTask(taskId);
    logAudit(user, 'delete_task', 'task', taskId, { title: existing.title });
    return sendJson(res, 200, { ok: true });
  })(req, res, user, urlObj);

  const reviewId = parseReviewRoute(pathname);
  if (req.method === 'PATCH' && reviewId) return safeEndpoint(async () => {
    const existing = getTask(reviewId);
    if (!existing) return sendJson(res, 404, { error: 'Task not found' });
    if (!userCanReview(user, existing)) return sendJson(res, 403, { error: 'role cannot review this task' });
    const body = await getBody(req);
    const task = taskFromBody({ ...existing, ...body }, existing);
    saveTask(task);
    logAudit(user, 'review_task', 'task', task.id, { approved: task.approved, revisions: task.revisions });
    return sendJson(res, 200, task);
  })(req, res, user, urlObj);

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  res.writeHead(404);
  res.end('Not found');
});

function startServer(port) {
  server.listen(port);
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    const current = Number(server.address()?.port || PORT);
    const nextPort = current + 1;
    console.warn(`Port ${current} is busy, retrying on ${nextPort}...`);
    setTimeout(() => startServer(nextPort), 150);
    return;
  }
  throw err;
});

server.on('listening', () => {
  const addr = server.address();
  const activePort = addr && typeof addr === 'object' ? addr.port : PORT;
  console.log(`AI Workflow Auditor running on http://localhost:${activePort}`);
  console.log(`Admin login: admin / ${ADMIN_PASSWORD === 'admin' ? 'admin (set ADMIN_PASSWORD to change)' : 'configured via ADMIN_PASSWORD'}`);
});

startServer(Number(PORT));
