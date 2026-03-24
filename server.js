const http = require('http');
const fs = require('fs');
const path = require('path');
const { AVAILABLE_PLUGINS, normalizePluginState, executePlugins } = require('./plugins');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'store.json');

function readStore() {
  if (!fs.existsSync(DB_PATH)) {
    return { tasks: [], pluginState: normalizePluginState({}) };
  }

  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const parsed = JSON.parse(raw || '{"tasks":[]}');
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    pluginState: normalizePluginState(parsed.pluginState)
  };
}

function writeStore(store) {
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
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

function buildMetrics(tasks) {
  const total = tasks.length;
  const totalBefore = tasks.reduce((acc, t) => acc + (Number(t.withoutAiMinutes) || 0), 0);
  const totalAfter = tasks.reduce((acc, t) => acc + (Number(t.withAiMinutes) || 0), 0);
  const savedMinutes = Math.max(totalBefore - totalAfter, 0);

  const approvedCount = tasks.filter(t => t.approved === true).length;
  const approvalRate = total ? +(approvedCount / total * 100).toFixed(1) : 0;

  const revisionsAvg = total
    ? +(tasks.reduce((acc, t) => acc + (Number(t.revisions) || 0), 0) / total).toFixed(2)
    : 0;

  const riskCounters = {};
  const pluginUsage = {};
  for (const task of tasks) {
    const flags = Array.isArray(task.riskFlags) ? task.riskFlags : [];
    for (const flag of flags) {
      riskCounters[flag] = (riskCounters[flag] || 0) + 1;
    }
    for (const pluginId of task.pluginApplied || []) {
      pluginUsage[pluginId] = (pluginUsage[pluginId] || 0) + 1;
    }
  }

  return {
    totalTasks: total,
    totalBeforeMinutes: totalBefore,
    totalAfterMinutes: totalAfter,
    savedMinutes,
    savedHours: +(savedMinutes / 60).toFixed(2),
    approvalRate,
    revisionsAvg,
    riskCounters,
    pluginUsage
  };
}

function parseReviewRoute(urlPath) {
  const match = /^\/api\/tasks\/([^/]+)\/review$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function parsePluginRoute(urlPath) {
  const match = /^\/api\/plugins\/([^/]+)$/.exec(urlPath);
  return match ? decodeURIComponent(match[1]) : null;
}

function pluginPayload(store) {
  return AVAILABLE_PLUGINS.map(plugin => ({
    id: plugin.id,
    role: plugin.role,
    name: plugin.name,
    description: plugin.description,
    enabled: store.pluginState[plugin.id] !== false
  }));
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);

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

    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    const store = readStore();
    return sendJson(res, 200, store.tasks);
  }

  if (req.method === 'GET' && pathname === '/api/plugins') {
    const store = readStore();
    return sendJson(res, 200, pluginPayload(store));
  }

  const pluginId = parsePluginRoute(pathname);
  if (req.method === 'PATCH' && pluginId) {
    try {
      const body = await getBody(req);
      const store = readStore();
      if (!Object.prototype.hasOwnProperty.call(store.pluginState, pluginId)) {
        return sendJson(res, 404, { error: 'Plugin not found' });
      }

      store.pluginState[pluginId] = Boolean(body.enabled);
      writeStore(store);
      return sendJson(res, 200, pluginPayload(store));
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/tasks') {
    try {
      const body = await getBody(req);
      if (!body.title || !body.department || !body.owner) {
        return sendJson(res, 400, { error: 'title, department, owner are required' });
      }

      const baseTask = {
        id: `t_${Date.now()}`,
        createdAt: new Date().toISOString(),
        title: String(body.title),
        department: String(body.department),
        owner: String(body.owner),
        withoutAiMinutes: Number(body.withoutAiMinutes) || 0,
        withAiMinutes: Number(body.withAiMinutes) || 0,
        revisions: Number(body.revisions) || 0,
        approved: Boolean(body.approved),
        riskFlags: Array.isArray(body.riskFlags) ? body.riskFlags.map(String) : []
      };

      const store = readStore();
      const pluginResult = executePlugins(baseTask, store.pluginState);
      const task = {
        ...baseTask,
        riskFlags: pluginResult.riskFlags,
        pluginFindings: pluginResult.pluginFindings,
        pluginSuggestions: pluginResult.pluginSuggestions,
        pluginApplied: pluginResult.pluginApplied
      };

      store.tasks.unshift(task);
      writeStore(store);
      return sendJson(res, 201, task);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  const reviewId = parseReviewRoute(pathname);
  if (req.method === 'PATCH' && reviewId) {
    try {
      const body = await getBody(req);
      const store = readStore();
      const idx = store.tasks.findIndex(t => t.id === reviewId);
      if (idx === -1) {
        return sendJson(res, 404, { error: 'Task not found' });
      }

      if (body.revisions !== undefined) {
        store.tasks[idx].revisions = Number(body.revisions) || 0;
      }
      if (body.approved !== undefined) {
        store.tasks[idx].approved = Boolean(body.approved);
      }
      if (body.riskFlags !== undefined) {
        store.tasks[idx].riskFlags = Array.isArray(body.riskFlags) ? body.riskFlags.map(String) : [];
      }

      store.tasks[idx].updatedAt = new Date().toISOString();
      writeStore(store);

      return sendJson(res, 200, store.tasks[idx]);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/metrics') {
    const store = readStore();
    return sendJson(res, 200, buildMetrics(store.tasks));
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

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
});

startServer(Number(PORT));
