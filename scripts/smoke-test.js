const { spawn } = require('child_process');

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const cookieJar = [];

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookieJar.length && !options.noCookie) headers.Cookie = cookieJar.join('; ');
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookieJar.push(setCookie.split(';')[0]);
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return { res, body };
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'admin', AUDITOR_INGEST_TOKEN: 'smoke-ingest-token' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    let ready = false;
    child.stdout.on('data', chunk => {
      if (String(chunk).includes(`localhost:${PORT}`)) ready = true;
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    for (let i = 0; i < 40 && !ready; i += 1) await wait(100);
    if (!ready) throw new Error('server did not start');

    await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    });

    const created = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Smoke Codex task',
        aiTool: 'Codex',
        department: 'product',
        owner: 'Smoke',
        withoutAiMinutes: 120,
        withAiMinutes: 30,
        revisions: 1,
        approved: true,
        riskFlags: []
      })
    });

    const report = await request('/api/report');
    if (!report.body.byTool.some(row => row.label === 'Codex')) throw new Error('Codex missing from byTool report');

    const filtered = await request('/api/tasks?aiTool=Codex');
    if (!filtered.body.some(task => task.id === created.body.id)) throw new Error('aiTool filter did not return created task');

    const pdf = await request('/api/export/report.pdf');
    if (!String(pdf.body).startsWith('%PDF-')) throw new Error('PDF export is not a PDF');

    const csv = await request('/api/export/tasks.csv');
    if (!String(csv.body).includes('"aiTool"')) throw new Error('CSV export missing aiTool');

    const usageCsv = [
      'provider,tool,model,project,user,department,requests,inputTokens,outputTokens,totalTokens,costUsd,periodStart,periodEnd',
      'openai,Codex,gpt-5.1,smoke,SmokeUser,product,12,1000,500,1500,1.23,2026-07-01,2026-07-01'
    ].join('\n');
    await request('/api/usage/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: usageCsv })
    });
    const usage = await request('/api/usage');
    if (usage.body.summary.totalEvents < 1 || usage.body.summary.totalCostUsd < 1) throw new Error('usage import missing from summary');
    if (!usage.body.summary.byUser.some(row => row.label === 'SmokeUser')) throw new Error('usage summary missing user breakdown');
    if (!usage.body.summary.userToolRows.some(row => row.user === 'SmokeUser' && row.tool === 'Codex')) throw new Error('usage summary missing user/tool breakdown');
    await request('/api/usage/cli-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: 'SmokeUser',
        department: 'product',
        line: [
          'main: Model: Sonnet 5 | Cost: $3.48 | Session: 41.0% | Weekly: 51.0% | Ctx Used: 18.0% | Block: 4hr 31m | Weekly Reset: 14hr 18m',
          'worker: Model: Sonnet 5 | Cost: $1.20 | Session: 12.0% | Weekly: 52.0% | Ctx Used: 8.0%'
        ].join('\n')
      })
    });
    const cliUsage = await request('/api/usage');
    if (!cliUsage.body.summary.userToolRows.some(row => row.user === 'SmokeUser' && row.tool === 'Claude CLI' && row.costUsd >= 4.68)) throw new Error('CLI status import missing from usage summary');
    await request('/api/usage/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          id: 'smoke-monitor-event',
          provider: 'claude-subscription',
          tool: 'Claude CLI',
          model: 'claude-sonnet-5',
          project: 'monitor smoke',
          user: 'SmokeUser',
          department: 'product',
          requests: 1,
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          costUsd: 0.42,
          source: 'claude-cli-monitor-delta'
        }]
      })
    });
    const monitorUsage = await request('/api/usage');
    if (!monitorUsage.body.summary.userToolRows.some(row => row.user === 'SmokeUser' && row.tool === 'Claude CLI' && row.costUsd >= 5.1)) throw new Error('usage events endpoint missing from summary');
    await request('/api/usage/events', {
      method: 'POST',
      noCookie: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer smoke-ingest-token' },
      body: JSON.stringify({
        events: [],
        monitor: {
          source: 'usage-monitor',
          version: 'smoke',
          activeSessions: 3,
          observedSessions: 4,
          costRows: 5,
          user: 'SmokeUser',
          department: 'product'
        }
      })
    });
    const heartbeatUsage = await request('/api/usage');
    if (!heartbeatUsage.body.monitor || heartbeatUsage.body.monitor.activeSessions !== 3) throw new Error('monitor heartbeat missing from usage payload');
    if (!heartbeatUsage.body.summary.bySession?.length) throw new Error('usage summary missing session breakdown');
    if (!heartbeatUsage.body.summary.byDay?.length) throw new Error('usage summary missing day breakdown');
    if (!heartbeatUsage.body.summary.byWeek?.length) throw new Error('usage summary missing week breakdown');
    if (!heartbeatUsage.body.summary.byMonth?.length) throw new Error('usage summary missing month breakdown');
    if (!heartbeatUsage.body.summary.bySource?.some(row => row.label === 'claude-cli-monitor-delta')) throw new Error('usage summary missing source breakdown');
    const filteredUsage = await request('/api/usage?source=claude-cli-monitor-delta');
    if (!filteredUsage.body.events.every(event => event.source === 'claude-cli-monitor-delta')) throw new Error('usage source filter returned wrong events');
    const usageExport = await request('/api/export/usage.csv?source=claude-cli-monitor-delta');
    if (!String(usageExport.body).includes('"source"') || !String(usageExport.body).includes('claude-cli-monitor-delta')) throw new Error('usage CSV export missing expected data');
    const usagePdf = await request('/api/export/usage.pdf?source=claude-cli-monitor-delta');
    if (!String(usagePdf.body).startsWith('%PDF-')) throw new Error('usage PDF export is not a PDF');
    const sync = await request('/api/usage/sync', { method: 'POST' });
    if (!Array.isArray(sync.body.results)) throw new Error('usage sync did not return provider statuses');

    await request(`/api/tasks/${encodeURIComponent(created.body.id)}`, { method: 'DELETE' });
    console.log('smoke-test-ok');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
