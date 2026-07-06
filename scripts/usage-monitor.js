#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_AUDITOR_URL = 'https://ai-workflow-auditor-ashen.vercel.app';
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.ai-workflow-auditor');
const DEFAULT_STATE_PATH = path.join(CONFIG_DIR, 'usage-monitor-state.json');
const DEFAULT_CLAUDE_DIR = path.join(HOME, '.claude');
const DEFAULT_INTERVAL_MS = 60_000;
const STATUSLINE_BRIDGE_CONFIG = path.join(CONFIG_DIR, 'statusline-bridge.json');
const STATUSLINE_LATEST_DIR = path.join(CONFIG_DIR, 'statusline-latest');
const PROJECT_MAP_PATH = path.join(CONFIG_DIR, 'project-map.json');
const SNAPSHOT_RETENTION_DAYS = Number(process.env.AUDITOR_SNAPSHOT_RETENTION_DAYS || 14) || 14;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function processExists(pid) {
  const id = Number(pid);
  if (!id) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { command: argv[2] || 'once' };
  for (let i = 3; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function configFromEnv(args = {}) {
  return {
    auditorUrl: String(args.url || process.env.AUDITOR_URL || DEFAULT_AUDITOR_URL).replace(/\/$/, ''),
    ingestToken: String(args.token || process.env.AUDITOR_INGEST_TOKEN || ''),
    username: String(args.username || process.env.AUDITOR_USERNAME || 'admin'),
    password: String(args.password || process.env.AUDITOR_PASSWORD || 'admin'),
    usageUser: String(args.user || process.env.AUDITOR_USAGE_USER || os.userInfo().username || 'local'),
    department: String(args.department || process.env.AUDITOR_USAGE_DEPARTMENT || ''),
    claudeDir: String(args.claudeDir || process.env.CLAUDE_DIR || DEFAULT_CLAUDE_DIR),
    statePath: String(args.state || process.env.AUDITOR_MONITOR_STATE || DEFAULT_STATE_PATH),
    projectMapPath: String(args.projectMap || process.env.AUDITOR_PROJECT_MAP || PROJECT_MAP_PATH),
    intervalMs: Math.max(10_000, Number(args.interval || process.env.AUDITOR_INTERVAL_MS || DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS),
    dryRun: Boolean(args['dry-run'] || process.env.AUDITOR_DRY_RUN)
  };
}

function loadProjectMap(config) {
  const raw = readJson(config.projectMapPath, []);
  return Array.isArray(raw) ? raw : [];
}

function inferProject(cwd, config) {
  const text = String(cwd || '');
  const rules = loadProjectMap(config);
  for (const rule of rules) {
    const match = String(rule.match || '').trim();
    if (match && text.includes(match)) return String(rule.project || rule.name || match).trim();
  }
  const parts = text.split(path.sep).filter(Boolean);
  return parts.at(-1) || 'local';
}

function readClaudeSessions(claudeDir) {
  const sessionsDir = path.join(claudeDir, 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter(file => file.endsWith('.json'));
  } catch {
    return new Map();
  }

  const sessions = new Map();
  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    const data = readJson(filePath);
    if (!data || !data.sessionId) continue;
    const alive = processExists(data.pid);
    sessions.set(String(data.sessionId), {
      sessionId: String(data.sessionId),
      name: String(data.name || path.basename(file, '.json')),
      pid: Number(data.pid) || 0,
      cwd: String(data.cwd || ''),
      status: alive ? String(data.status || 'active') : 'closed',
      startedAt: Number(data.startedAt) || 0,
      updatedAt: Number(data.updatedAt || data.statusUpdatedAt || 0),
      alive,
      filePath
    });
  }
  return sessions;
}

function readClaudeCosts(claudeDir) {
  const costsPath = path.join(claudeDir, 'metrics', 'costs.jsonl');
  const bySession = new Map();
  let content = '';
  try {
    content = fs.readFileSync(costsPath, 'utf8');
  } catch {
    return bySession;
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row.session_id) continue;
      bySession.set(String(row.session_id), {
        sessionId: String(row.session_id),
        timestamp: String(row.timestamp || new Date().toISOString()),
        transcriptPath: String(row.transcript_path || ''),
        model: String(row.model || 'Claude CLI'),
        inputTokens: toNumber(row.input_tokens),
        outputTokens: toNumber(row.output_tokens),
        totalTokens: toNumber(row.input_tokens) + toNumber(row.output_tokens),
        costUsd: toNumber(row.estimated_cost_usd)
      });
    } catch {
      // Ignore malformed hook rows; the monitor should never break active work.
    }
  }
  return bySession;
}

function readBridgeCosts() {
  const bySession = new Map();
  let files = [];
  try {
    files = fs.readdirSync(os.tmpdir()).filter(file => file.startsWith('ecc-metrics-') && file.endsWith('.json'));
  } catch {
    return bySession;
  }

  for (const file of files) {
    const data = readJson(path.join(os.tmpdir(), file));
    const sessionId = String(data?.session_id || file.replace(/^ecc-metrics-/, '').replace(/\.json$/, ''));
    if (!sessionId) continue;
    bySession.set(sessionId, {
      sessionId,
      timestamp: String(data.last_timestamp || new Date().toISOString()),
      transcriptPath: '',
      model: 'Claude CLI',
      inputTokens: toNumber(data.total_input_tokens),
      outputTokens: toNumber(data.total_output_tokens),
      totalTokens: toNumber(data.total_input_tokens) + toNumber(data.total_output_tokens),
      costUsd: toNumber(data.total_cost_usd)
    });
  }
  return bySession;
}

function readStatuslineCosts() {
  const bySession = new Map();
  let files = [];
  try {
    files = fs.readdirSync(STATUSLINE_LATEST_DIR).filter(file => file.endsWith('.json'));
  } catch {
    return bySession;
  }

  for (const file of files) {
    const data = readJson(path.join(STATUSLINE_LATEST_DIR, file));
    if (!data?.sessionId) continue;
    bySession.set(String(data.sessionId), {
      sessionId: String(data.sessionId),
      timestamp: String(data.timestamp || new Date().toISOString()),
      transcriptPath: '',
      model: String(data.model || 'Claude CLI'),
      inputTokens: toNumber(data.inputTokens),
      outputTokens: toNumber(data.outputTokens),
      totalTokens: toNumber(data.totalTokens || toNumber(data.inputTokens) + toNumber(data.outputTokens)),
      costUsd: toNumber(data.costUsd)
    });
  }
  return bySession;
}

function mergeCostMaps(primary, fallback) {
  const merged = new Map(fallback);
  for (const [sessionId, cost] of primary.entries()) merged.set(sessionId, cost);
  return merged;
}

function eventBase(config, session, cost, kind) {
  const now = new Date().toISOString();
  const projectName = inferProject(session?.cwd || '', config);
  const parts = [
    projectName ? `project ${projectName}` : '',
    session?.name ? `окно ${session.name}` : `session ${String(cost?.sessionId || session?.sessionId || '').slice(0, 8)}`,
    session?.status ? `status ${session.status}` : '',
    session?.cwd ? `cwd ${session.cwd}` : ''
  ].filter(Boolean);
  return {
    createdAt: now,
    periodStart: now,
    periodEnd: now,
    provider: 'claude-subscription',
    tool: 'Claude CLI',
    model: cost?.model || 'Claude CLI',
    project: parts.join(' / '),
    user: config.usageUser,
    department: config.department,
    source: `claude-cli-monitor-${kind}`
  };
}

function cleanupLocalSnapshots() {
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const file of fs.readdirSync(STATUSLINE_LATEST_DIR)) {
      const filePath = path.join(STATUSLINE_LATEST_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch {
    // best effort
  }
  const historyPath = path.join(CONFIG_DIR, 'statusline-snapshots.jsonl');
  try {
    const rows = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    const kept = rows.filter(line => {
      try {
        const row = JSON.parse(line);
        return new Date(row.timestamp || 0).getTime() >= cutoff;
      } catch {
        return false;
      }
    });
    if (kept.length !== rows.length) fs.writeFileSync(historyPath, `${kept.join('\n')}\n`, 'utf8');
  } catch {
    // best effort
  }
}

function buildEvents(config, state, sessions, costs) {
  const events = [];
  const previous = state.sessions || {};
  const allSessionIds = new Set([...sessions.keys(), ...costs.keys(), ...Object.keys(previous)]);

  for (const sessionId of allSessionIds) {
    const session = sessions.get(sessionId) || null;
    const cost = costs.get(sessionId) || null;
    const prev = previous[sessionId] || {};
    const isOpen = Boolean(session && session.alive);
    const hadOpenEvent = Boolean(prev.openSent);

    if (isOpen && !hadOpenEvent) {
      events.push({
        ...eventBase(config, session, cost, 'open'),
        id: `claude-monitor-open-${hash(sessionId)}`,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0
      });
    }

    if (cost) {
      const deltaCost = Math.max(0, toNumber(cost.costUsd) - toNumber(prev.totalCostUsd));
      const deltaInput = Math.max(0, toNumber(cost.inputTokens) - toNumber(prev.inputTokens));
      const deltaOutput = Math.max(0, toNumber(cost.outputTokens) - toNumber(prev.outputTokens));
      if (deltaCost > 0.000001 || deltaInput > 0 || deltaOutput > 0) {
        events.push({
          ...eventBase(config, session, cost, 'delta'),
          id: `claude-monitor-delta-${hash(`${sessionId}:${cost.costUsd}:${cost.inputTokens}:${cost.outputTokens}`)}`,
          requests: 1,
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
          totalTokens: deltaInput + deltaOutput,
          costUsd: +deltaCost.toFixed(6)
        });
      }
    }

    if (prev.openSent && !prev.closedSent && !isOpen) {
      events.push({
        ...eventBase(config, session || prev.lastSession || null, cost, 'close'),
        id: `claude-monitor-close-${hash(`${sessionId}:${prev.totalCostUsd || 0}`)}`,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0
      });
    }
  }

  return events;
}

function nextState(state, sessions, costs, sentEvents) {
  const current = { ...state, sessions: { ...(state.sessions || {}) }, updatedAt: new Date().toISOString() };
  const sentBySource = new Set(sentEvents.map(event => `${event.source}:${event.id}`));
  const allSessionIds = new Set([...sessions.keys(), ...costs.keys(), ...Object.keys(current.sessions)]);

  for (const sessionId of allSessionIds) {
    const session = sessions.get(sessionId) || null;
    const cost = costs.get(sessionId) || null;
    const prev = current.sessions[sessionId] || {};
    const isOpen = Boolean(session && session.alive);
    const openSent = prev.openSent || sentBySource.has(`claude-cli-monitor-open:claude-monitor-open-${hash(sessionId)}`);
    const closedSent = prev.closedSent || sentBySource.has(`claude-cli-monitor-close:claude-monitor-close-${hash(`${sessionId}:${prev.totalCostUsd || 0}`)}`);

    current.sessions[sessionId] = {
      openSent: Boolean(openSent || isOpen),
      closedSent: Boolean(closedSent || (!isOpen && prev.openSent)),
      totalCostUsd: cost ? toNumber(cost.costUsd) : toNumber(prev.totalCostUsd),
      inputTokens: cost ? toNumber(cost.inputTokens) : toNumber(prev.inputTokens),
      outputTokens: cost ? toNumber(cost.outputTokens) : toNumber(prev.outputTokens),
      lastSeenAt: new Date().toISOString(),
      lastSession: session || prev.lastSession || null
    };
  }

  return current;
}

async function login(config) {
  const response = await fetch(`${config.auditorUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password })
  });
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status} ${await response.text()}`);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('login did not return a session cookie');
  return cookie.split(';')[0];
}

async function sendEvents(config, events) {
  const monitor = config.currentMonitor || {};
  if (config.dryRun) {
    console.log(JSON.stringify({ dryRun: true, events, monitor }, null, 2));
    return { imported: events.length };
  }

  const headers = { 'content-type': 'application/json' };
  if (config.ingestToken) {
    headers.authorization = `Bearer ${config.ingestToken}`;
  } else {
    headers.cookie = await login(config);
  }
  const response = await fetch(`${config.auditorUrl}/api/usage/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events, monitor })
  });
  if (!response.ok) throw new Error(`usage upload failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function runOnce(config) {
  cleanupLocalSnapshots();
  const state = readJson(config.statePath, { sessions: {} }) || { sessions: {} };
  const sessions = readClaudeSessions(config.claudeDir);
  const costs = mergeCostMaps(readClaudeCosts(config.claudeDir), mergeCostMaps(readStatuslineCosts(), readBridgeCosts()));
  const events = buildEvents(config, state, sessions, costs);
  config.currentMonitor = {
    source: 'usage-monitor',
    version: '2026-07-06',
    activeSessions: [...sessions.values()].filter(session => session.alive).length,
    observedSessions: sessions.size,
    costRows: costs.size,
    user: config.usageUser,
    department: config.department
  };
  const result = await sendEvents(config, events);
  if (!config.dryRun) writeJson(config.statePath, nextState(state, sessions, costs, events));
  const totalCost = events.reduce((sum, event) => sum + toNumber(event.costUsd), 0);
  console.log(`[usage-monitor] sessions=${sessions.size} costRows=${costs.size} sent=${result.imported || 0} costDelta=$${totalCost.toFixed(4)}`);
}

async function watch(config) {
  await runOnce(config);
  setInterval(() => {
    runOnce(config).catch(error => {
      console.error(`[usage-monitor] ${error.message}`);
    });
  }, config.intervalMs);
}

function plistEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function installStatuslineBridge(config) {
  const settingsPath = path.join(config.claudeDir, 'settings.json');
  const settings = readJson(settingsPath, {}) || {};
  const bridgeScript = path.join(__dirname, 'claude-statusline-bridge.js');
  const bridgeCommand = `${shellQuote(process.execPath)} ${shellQuote(path.resolve(bridgeScript))}`;
  const current = settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : {};
  const currentCommand = String(current.command || 'npx -y ccstatusline@latest');

  if (!currentCommand.includes('claude-statusline-bridge.js')) {
    ensureDir(CONFIG_DIR);
    writeJson(STATUSLINE_BRIDGE_CONFIG, { originalCommand: currentCommand, installedAt: new Date().toISOString() });
  }

  const backupPath = `${settingsPath}.backup-ai-workflow-auditor-${Date.now()}`;
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, backupPath);
  settings.statusLine = {
    ...current,
    type: 'command',
    command: bridgeCommand,
    padding: current.padding ?? 0
  };
  writeJson(settingsPath, settings);
  console.log(`[usage-monitor] installed Claude statusline bridge in ${settingsPath}`);
  console.log(`[usage-monitor] backup ${backupPath}`);
  console.log(`[usage-monitor] original statusline command: ${currentCommand}`);
}

function installLaunchAgent(config) {
  const plistPath = path.join(HOME, 'Library', 'LaunchAgents', 'app.ai-workflow-auditor.usage-monitor.plist');
  const nodePath = process.execPath;
  const scriptPath = path.resolve(__filename);
  const logPath = path.join(CONFIG_DIR, 'usage-monitor.log');
  const errPath = path.join(CONFIG_DIR, 'usage-monitor.err.log');
  ensureDir(path.dirname(plistPath));
  ensureDir(CONFIG_DIR);
  if (!fs.existsSync(config.projectMapPath)) {
    writeJson(config.projectMapPath, [
      { match: '/Users/guldana/Documents/New project/ai-content-platform', project: 'ai-content-platform' },
      { match: '/Users/guldana/Documents/New project/ai-workflow-auditor', project: 'ai-workflow-auditor' }
    ]);
  }

  const env = {
    AUDITOR_URL: config.auditorUrl,
    AUDITOR_USAGE_USER: config.usageUser,
    AUDITOR_USAGE_DEPARTMENT: config.department,
    CLAUDE_DIR: config.claudeDir,
    AUDITOR_MONITOR_STATE: config.statePath,
    AUDITOR_PROJECT_MAP: config.projectMapPath,
    AUDITOR_INTERVAL_MS: String(config.intervalMs)
  };
  if (config.ingestToken) {
    env.AUDITOR_INGEST_TOKEN = config.ingestToken;
  } else {
    env.AUDITOR_USERNAME = config.username;
    env.AUDITOR_PASSWORD = config.password;
  }

  const envXml = Object.entries(env).map(([key, value]) => `    <key>${plistEscape(key)}</key><string>${plistEscape(value)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.ai-workflow-auditor.usage-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(nodePath)}</string>
    <string>${plistEscape(scriptPath)}</string>
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${plistEscape(errPath)}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, { encoding: 'utf8', mode: 0o600 });
  const uid = process.getuid ? process.getuid() : '';
  spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  const result = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${result.stderr || result.stdout}`);
  }
  console.log(`[usage-monitor] installed ${plistPath}`);
  console.log(`[usage-monitor] logs ${logPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const config = configFromEnv(args);
  if (args.command === 'once') return runOnce(config);
  if (args.command === 'watch') return watch(config);
  if (args.command === 'install-launchd') return installLaunchAgent(config);
  if (args.command === 'install-statusline') return installStatuslineBridge(config);
  if (args.command === 'dry-run') {
    config.dryRun = true;
    return runOnce(config);
  }
  console.log('Usage: node scripts/usage-monitor.js once|watch|dry-run|install-statusline|install-launchd [--url URL] [--username USER] [--password PASS] [--user LABEL] [--department NAME] [--interval MS]');
}

main().catch(error => {
  console.error(`[usage-monitor] ${error.stack || error.message}`);
  process.exit(1);
});
