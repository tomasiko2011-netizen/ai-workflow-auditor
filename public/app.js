const loginPanel = document.getElementById('loginPanel');
const appPanel = document.getElementById('appPanel');
const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');
const taskForm = document.getElementById('taskForm');
const filterForm = document.getElementById('filterForm');
const importForm = document.getElementById('importForm');
const usageImportForm = document.getElementById('usageImportForm');
const cliStatusForm = document.getElementById('cliStatusForm');
const ruleForm = document.getElementById('ruleForm');
const userForm = document.getElementById('userForm');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const cancelRuleBtn = document.getElementById('cancelRuleBtn');
const saveTaskBtn = document.getElementById('saveTaskBtn');
const saveRuleBtn = document.getElementById('saveRuleBtn');
const formTitle = document.getElementById('formTitle');
const taskRows = document.getElementById('taskRows');
const metricsEl = document.getElementById('metrics');
const pluginsEl = document.getElementById('plugins');
const reportEl = document.getElementById('report');
const insightsEl = document.getElementById('insights');
const rulesEl = document.getElementById('rules');
const usersEl = document.getElementById('users');
const auditLogEl = document.getElementById('auditLog');
const importResultEl = document.getElementById('importResult');
const usageImportResultEl = document.getElementById('usageImportResult');
const cliStatusResultEl = document.getElementById('cliStatusResult');
const usageSyncResultEl = document.getElementById('usageSyncResult');
const syncUsageBtn = document.getElementById('syncUsageBtn');
const usageMetricsEl = document.getElementById('usageMetrics');
const monitorFreshnessEl = document.getElementById('monitorFreshness');
const monitorStatusEl = document.getElementById('monitorStatus');
const monitorDetailsEl = document.getElementById('monitorDetails');
const usageProviderChartEl = document.getElementById('usageProviderChart');
const usageToolChartEl = document.getElementById('usageToolChart');
const usageUserChartEl = document.getElementById('usageUserChart');
const usageModelChartEl = document.getElementById('usageModelChart');
const usageRowsEl = document.getElementById('usageRows');
const usageUserRowsEl = document.getElementById('usageUserRows');
const sessionInfoEl = document.getElementById('sessionInfo');
const exportTasksLink = document.getElementById('exportTasksLink');
const exportReportLink = document.getElementById('exportReportLink');
const exportPdfLink = document.getElementById('exportPdfLink');
const toolChartEl = document.getElementById('toolChart');
const departmentChartEl = document.getElementById('departmentChart');
const qualityChartEl = document.getElementById('qualityChart');
const riskChartEl = document.getElementById('riskChart');
const usagePulseEl = document.getElementById('usagePulse');
const riskMatrixEl = document.getElementById('riskMatrix');
const rulesSection = document.getElementById('rulesSection');
const usersSection = document.getElementById('usersSection');
const tabButtons = [...document.querySelectorAll('.tab-button')];
const tabPanels = [...document.querySelectorAll('.tab-panel')];

const nf = new Intl.NumberFormat('ru-RU');
let tasksCache = [];
let rulesCache = [];
let usageCache = [];
let currentUser = null;

const departmentLabels = {
  marketing: 'Маркетинг',
  legal: 'Юристы',
  ops: 'Операции',
  finance: 'Финансы',
  product: 'Продукт',
  unknown: 'Не указан',
  Unknown: 'Не указан'
};

const roleLabels = {
  admin: 'Администратор',
  manager: 'Менеджер',
  reviewer: 'Ревьюер',
  viewer: 'Наблюдатель',
  marketing: 'маркетинг',
  legal: 'юристы'
};

const pluginLabels = {
  'marketing-quality': 'Качество маркетинга',
  'legal-compliance': 'Юридический комплаенс',
  'manager-roi': 'ROI для руководителя'
};

const pluginDescriptions = {
  'marketing-quality': 'Проверяет бренд-безопасность и гипотезы в маркетинговых задачах.',
  'legal-compliance': 'Находит юридические, комплаенс и PII-риски.',
  'manager-roi': 'Подсвечивает задачи с низким ROI или большим числом правок.'
};

const actionLabels = {
  login: 'Вход',
  logout: 'Выход',
  create_task: 'Создание задачи',
  update_task: 'Обновление задачи',
  delete_task: 'Удаление задачи',
  review_task: 'Проверка задачи',
  import_csv: 'Импорт CSV',
  export_tasks_csv: 'Экспорт задач CSV',
  export_report_csv: 'Экспорт отчёта CSV',
  export_report_pdf: 'Экспорт отчёта PDF',
  import_usage_csv: 'Импорт usage CSV',
  sync_usage: 'Синхронизация usage',
  import_cli_usage: 'Импорт CLI usage',
  update_plugin: 'Изменение проверки',
  create_rule: 'Создание правила',
  update_rule: 'Обновление правила',
  delete_rule: 'Удаление правила',
  upsert_user: 'Сохранение пользователя',
  delete_user: 'Удаление пользователя'
};

const targetLabels = {
  session: 'сессия',
  task: 'задача',
  report: 'отчёт',
  usage: 'usage',
  plugin: 'проверка',
  rule: 'правило',
  user: 'пользователь'
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function label(map, value, fallback = 'Не указан') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return map[text] || text;
}

function toolLabel(value) {
  if (!value || value === 'Unknown') return 'Не указан';
  if (value === 'Other') return 'Другой';
  return value;
}

function riskLabel(value) {
  const labels = {
    pii: 'PII',
    compliance: 'Комплаенс',
    'brand-safety': 'Бренд-безопасность',
    'quality-drift': 'Дрейф качества'
  };
  return labels[value] || value;
}

function listText(items, mapper = value => value) {
  const values = (items || []).filter(Boolean).map(mapper);
  return values.length ? values.join(', ') : '-';
}

function metricCard(labelText, value) {
  return `<div class="metric"><div class="label">${esc(labelText)}</div><div class="value">${esc(value)}</div></div>`;
}

function usd(value) {
  return `$${nf.format(Number(value || 0).toFixed(2))}`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function setActiveTab(tab) {
  const allowed = currentUser?.role === 'admin' || !['rules', 'users'].includes(tab);
  const next = allowed ? tab : 'overview';
  tabButtons.forEach(button => button.classList.toggle('active', button.dataset.tab === next));
  tabPanels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === next));
}

function setAuthed(authed, user = null) {
  currentUser = user;
  loginPanel.hidden = authed;
  appPanel.hidden = !authed;
  logoutBtn.hidden = !authed;
  const admin = currentUser?.role === 'admin';
  tabButtons.filter(button => button.hasAttribute('data-admin-only')).forEach(button => {
    button.hidden = !admin;
  });
  rulesSection.hidden = !admin;
  usersSection.hidden = !admin;
  sessionInfoEl.textContent = user
    ? `${user.username} / ${label(roleLabels, user.role)}${user.department ? ` / ${label(departmentLabels, user.department)}` : ''}`
    : '';
  if (authed) setActiveTab('overview');
}

function filterQuery() {
  const params = new URLSearchParams();
  new FormData(filterForm).forEach((value, key) => {
    const text = String(value || '').trim();
    if (text) params.set(key, text);
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

function updateExportLinks() {
  exportTasksLink.href = `/api/export/tasks.csv${filterQuery()}`;
  exportReportLink.href = `/api/export/report.csv${filterQuery()}`;
  exportPdfLink.href = `/api/export/report.pdf${filterQuery()}`;
}

function taskPayloadFromForm() {
  const formData = new FormData(taskForm);
  return {
    title: formData.get('title'),
    aiTool: formData.get('aiTool'),
    department: formData.get('department'),
    owner: formData.get('owner'),
    withoutAiMinutes: Number(formData.get('withoutAiMinutes')),
    withAiMinutes: Number(formData.get('withAiMinutes')),
    revisions: Number(formData.get('revisions') || 0),
    approved: formData.get('approved') === 'true',
    riskFlags: String(formData.get('riskFlags') || '').split(',').map(v => v.trim()).filter(Boolean)
  };
}

function resetTaskForm() {
  taskForm.reset();
  taskForm.elements.id.value = '';
  formTitle.textContent = 'Новая задача';
  saveTaskBtn.textContent = 'Сохранить';
  cancelEditBtn.hidden = true;
}

function rulePayloadFromForm() {
  const formData = new FormData(ruleForm);
  return {
    name: formData.get('name'),
    matchText: formData.get('matchText'),
    matchDepartment: formData.get('matchDepartment'),
    minRevisions: formData.get('minRevisions'),
    maxRoiPercent: formData.get('maxRoiPercent'),
    addRisk: formData.get('addRisk'),
    finding: formData.get('finding'),
    suggestion: formData.get('suggestion'),
    enabled: formData.get('enabled') === 'true'
  };
}

function resetRuleForm() {
  ruleForm.reset();
  ruleForm.elements.id.value = '';
  saveRuleBtn.textContent = 'Сохранить правило';
  cancelRuleBtn.hidden = true;
}

async function loadPlugins() {
  const plugins = await fetchJson('/api/plugins');
  pluginsEl.innerHTML = plugins.map(plugin => `
    <label class="plugin-item">
      <input type="checkbox" data-plugin-id="${esc(plugin.id)}" ${plugin.enabled ? 'checked' : ''} ${currentUser?.role !== 'admin' ? 'disabled' : ''} />
      <div>
        <div class="plugin-title">${esc(label(pluginLabels, plugin.id))} <span>${esc(label(roleLabels, plugin.role))}</span></div>
        <div class="plugin-desc">${esc(pluginDescriptions[plugin.id] || plugin.description)}</div>
      </div>
    </label>
  `).join('');

  pluginsEl.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', async e => {
      const pluginId = e.target.getAttribute('data-plugin-id');
      const enabled = e.target.checked;
      try {
        await fetchJson(`/api/plugins/${encodeURIComponent(pluginId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        await refreshData();
      } catch (err) {
        e.target.checked = !enabled;
        alert(err.message);
      }
    });
  });
}

async function loadMetrics() {
  const m = await fetchJson(`/api/metrics${filterQuery()}`);
  const topPlugins = Object.entries(m.pluginUsage || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => `${label(pluginLabels, id)}: ${nf.format(count)}`)
    .join(' | ') || '-';
  const risks = Object.entries(m.riskCounters || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => `${riskLabel(id)}: ${nf.format(count)}`)
    .join(' | ') || '-';

  metricsEl.innerHTML = [
    metricCard('Задач', nf.format(m.totalTasks)),
    metricCard('Сэкономлено', `${nf.format(m.savedHours)} ч`),
    metricCard('Одобрено', `${m.approvalRate}%`),
    metricCard('Среднее правок', nf.format(m.revisionsAvg)),
    metricCard('Частые проверки', topPlugins),
    metricCard('Частые риски', risks)
  ].join('');

  renderQualityChart(m);
  renderRiskChart(m.riskCounters || {});
}

function chartRows(container, rows, options = {}) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty">${esc(options.empty || 'Нет данных')}</div>`;
    return;
  }
  const maxValue = Math.max(...rows.map(row => Number(row.value) || 0), 0.1);
  container.innerHTML = rows.map(row => {
    const width = Math.max(((Number(row.value) || 0) / maxValue) * 100, 4);
    return `
      <div class="bar-row">
        <div class="bar-row-head">
          <strong>${esc(row.label)}</strong>
          <span>${esc(row.meta)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill ${esc(row.tone || '')}" style="width:${width}%"></div></div>
      </div>
    `;
  }).join('');
}

function renderToolChart(rows) {
  chartRows(toolChartEl, (rows || []).map(row => ({
    label: toolLabel(row.label),
    value: row.savedHours,
    meta: `${nf.format(row.savedHours)} ч / ${nf.format(row.tasks)} задач / одобрено ${row.approvalRate}%`
  })), { empty: 'Нет данных по AI-инструментам' });
}

function renderDepartmentChart(rows) {
  chartRows(departmentChartEl, (rows || []).map(row => ({
    label: label(departmentLabels, row.label),
    value: row.savedHours,
    meta: `${nf.format(row.savedHours)} ч / ${nf.format(row.tasks)} задач / одобрено ${row.approvalRate}%`,
    tone: 'alt'
  })), { empty: 'Нет данных по отделам' });
}

function renderQualityChart(metrics) {
  const approval = Number(metrics.approvalRate) || 0;
  const revisions = Number(metrics.revisionsAvg) || 0;
  const revisionScore = Math.max(0, Math.min(100, 100 - revisions * 20));
  qualityChartEl.innerHTML = `
    <div class="donut-row">
      <div class="donut" style="--value:${approval}"><span>${approval}%</span></div>
      <div>
        <strong>Доля одобренных задач</strong>
        <p>Среднее число правок: ${esc(nf.format(revisions))}</p>
      </div>
    </div>
    <div class="bar-row">
      <div class="bar-row-head"><strong>Стабильность качества</strong><span>${nf.format(revisionScore)}%</span></div>
      <div class="bar-track"><div class="bar-fill warn" style="width:${revisionScore}%"></div></div>
    </div>
  `;
}

function renderRiskChart(counters) {
  const rows = Object.entries(counters)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ label: riskLabel(id), value: count, meta: `${nf.format(count)} задач`, tone: 'danger' }));
  chartRows(riskChartEl, rows, { empty: 'Рисков по текущим фильтрам нет' });
}

function renderUsagePulse(tasks) {
  if (!tasks.length) {
    usagePulseEl.innerHTML = '<div class="empty">Нет задач по текущим фильтрам</div>';
    return;
  }
  const totalSaved = tasks.reduce((sum, task) => sum + Math.max((task.withoutAiMinutes || 0) - (task.withAiMinutes || 0), 0), 0);
  const byTool = tasks.reduce((acc, task) => {
    const key = toolLabel(task.aiTool);
    acc[key] ||= { tasks: 0, saved: 0, revisions: 0 };
    acc[key].tasks += 1;
    acc[key].saved += Math.max((task.withoutAiMinutes || 0) - (task.withAiMinutes || 0), 0);
    acc[key].revisions += Number(task.revisions) || 0;
    return acc;
  }, {});
  usagePulseEl.innerHTML = Object.entries(byTool)
    .sort((a, b) => b[1].saved - a[1].saved)
    .map(([tool, stats]) => {
      const share = totalSaved ? Math.round((stats.saved / totalSaved) * 100) : 0;
      return `
        <div class="pulse-card">
          <strong>${esc(tool)}</strong>
          <span>${nf.format(stats.tasks)} задач</span>
          <div class="pulse-value">${nf.format(Math.round(stats.saved))} мин</div>
          <div class="bar-track"><div class="bar-fill alt" style="width:${Math.max(share, 4)}%"></div></div>
          <small>${share}% экономии / ${nf.format(stats.revisions)} правок</small>
        </div>
      `;
    }).join('');
}

function renderRiskMatrix(tasks) {
  const departments = [...new Set(tasks.map(task => task.department || 'unknown'))];
  const risks = [...new Set(tasks.flatMap(task => task.riskFlags || []))];
  if (!departments.length || !risks.length) {
    riskMatrixEl.innerHTML = '<div class="empty">Нет рисков для матрицы</div>';
    return;
  }
  const counts = {};
  let max = 1;
  for (const task of tasks) {
    const dept = task.department || 'unknown';
    for (const risk of task.riskFlags || []) {
      const key = `${dept}::${risk}`;
      counts[key] = (counts[key] || 0) + 1;
      max = Math.max(max, counts[key]);
    }
  }
  riskMatrixEl.innerHTML = `
    <table class="matrix-table">
      <thead>
        <tr><th>Отдел</th>${risks.map(risk => `<th>${esc(riskLabel(risk))}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${departments.map(dept => `
          <tr>
            <td>${esc(label(departmentLabels, dept))}</td>
            ${risks.map(risk => {
              const value = counts[`${dept}::${risk}`] || 0;
              const intensity = value ? Math.max(0.18, value / max) : 0;
              return `<td><span class="heat-cell" style="--heat:${intensity}">${value ? nf.format(value) : '-'}</span></td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderUsage(payload) {
  const summary = payload.summary || {};
  usageCache = payload.events || [];
  usageMetricsEl.innerHTML = [
    metricCard('Usage-событий', nf.format(summary.totalEvents || 0)),
    metricCard('Стоимость', usd(summary.totalCostUsd || 0)),
    metricCard('Токены', nf.format(summary.totalTokens || 0)),
    metricCard('Запросы', nf.format(summary.totalRequests || 0))
  ].join('');
  renderMonitorStatus(payload.monitor || null);
  chartRows(usageProviderChartEl, (summary.byProvider || []).map(row => ({
    label: row.label === 'unknown' ? 'Не указан' : row.label,
    value: row.costUsd || row.tokens || row.requests,
    meta: `${usd(row.costUsd)} / ${nf.format(row.tokens)} токенов / ${nf.format(row.requests)} запросов`
  })), { empty: 'Usage по провайдерам пока нет' });
  chartRows(usageToolChartEl, (summary.byTool || []).map(row => ({
    label: row.label === 'unknown' ? 'Не указан' : row.label,
    value: row.costUsd || row.tokens || row.requests,
    meta: `${usd(row.costUsd)} / ${nf.format(row.tokens)} токенов`,
    tone: 'alt'
  })), { empty: 'Usage по инструментам пока нет' });
  chartRows(usageUserChartEl, (summary.byUser || []).map(row => ({
    label: row.label === 'unknown' ? 'Не указан' : row.label,
    value: row.costUsd || row.tokens || row.requests,
    meta: `${usd(row.costUsd)} / ${nf.format(row.tokens)} токенов / ${nf.format(row.requests)} запросов`,
    tone: 'danger'
  })), { empty: 'Usage по пользователям пока нет' });
  chartRows(usageModelChartEl, (summary.byModel || []).filter(row => row.label !== 'unknown').slice(0, 8).map(row => ({
    label: row.label,
    value: row.costUsd || row.tokens || row.requests,
    meta: `${usd(row.costUsd)} / ${nf.format(row.requests)} запросов`,
    tone: 'warn'
  })), { empty: 'Данных по моделям пока нет' });
  usageUserRowsEl.innerHTML = (summary.userToolRows || []).length
    ? summary.userToolRows.slice(0, 80).map(row => `
      <tr>
        <td>${esc(row.user === 'unknown' ? 'Не указан' : row.user)}</td>
        <td>${esc(toolLabel(row.tool))}</td>
        <td>${nf.format(row.events || 0)}</td>
        <td>${nf.format(row.requests || 0)}</td>
        <td>${nf.format(row.tokens || 0)}</td>
        <td>${usd(row.costUsd || 0)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="6">Нет данных по пользователям. В usage CSV должно быть поле user или user_id.</td></tr>';
  usageRowsEl.innerHTML = usageCache.length
    ? usageCache.slice(0, 50).map(event => `
      <tr>
        <td>${esc(new Date(event.periodStart || event.createdAt).toLocaleDateString('ru-RU'))}</td>
        <td>${esc(event.provider || '-')}</td>
        <td>${esc(event.user || '-')}</td>
        <td>${esc(toolLabel(event.tool || event.provider))}</td>
        <td>${esc(event.model || '-')}</td>
        <td>${esc(event.project || '-')}</td>
        <td>${nf.format(event.requests || 0)}</td>
        <td>${nf.format(event.totalTokens || 0)}</td>
        <td>${usd(event.costUsd || 0)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="9">Usage-данных пока нет: нажмите синхронизацию или импортируйте CSV.</td></tr>';
}

function renderMonitorStatus(monitor) {
  if (!monitor) {
    monitorFreshnessEl.textContent = 'Нет сигнала';
    monitorFreshnessEl.className = 'status-pill muted';
    monitorStatusEl.innerHTML = [
      metricCard('Heartbeat', '-'),
      metricCard('Активных сессий', '0'),
      metricCard('Последняя дельта', usd(0)),
      metricCard('Событий', '0')
    ].join('');
    monitorDetailsEl.textContent = 'Локальный usage-monitor ещё не отправлял heartbeat.';
    return;
  }

  const heartbeat = monitor.lastHeartbeatAt ? new Date(monitor.lastHeartbeatAt) : null;
  const ageMs = heartbeat ? Date.now() - heartbeat.getTime() : Infinity;
  const isFresh = ageMs < 2 * 60 * 1000;
  monitorFreshnessEl.textContent = isFresh ? 'Живой' : 'Нет свежего сигнала';
  monitorFreshnessEl.className = `status-pill ${isFresh ? 'ok' : 'warn'}`;
  monitorStatusEl.innerHTML = [
    metricCard('Heartbeat', heartbeat ? heartbeat.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '-'),
    metricCard('Активных сессий', nf.format(monitor.activeSessions || 0)),
    metricCard('Последняя дельта', usd(monitor.lastCostDeltaUsd || 0)),
    metricCard('Событий', nf.format(monitor.lastUploadedEvents || 0))
  ].join('');
  const details = [
    `Источник: ${monitor.source || 'usage-monitor'}`,
    `Пользователь: ${monitor.user || '-'}`,
    `Отдел: ${departmentLabel(monitor.department || '')}`,
    `Наблюдаемых сессий: ${nf.format(monitor.observedSessions || 0)}`,
    `Cost rows: ${nf.format(monitor.costRows || 0)}`,
    monitor.lastError ? `Ошибка: ${monitor.lastError}` : ''
  ].filter(Boolean);
  monitorDetailsEl.textContent = details.join(' · ');
}

async function loadUsage() {
  renderUsage(await fetchJson('/api/usage'));
}

function reportTable(title, rows, valueLabel, formatter = value => value) {
  const body = rows.length
    ? rows.map(row => `
      <tr>
        <td>${esc(formatter(row.label))}</td>
        <td>${nf.format(row.tasks)}</td>
        <td>${nf.format(row.savedHours)} ч</td>
        <td>${row.approvalRate}%</td>
      </tr>
    `).join('')
    : '<tr><td colspan="4">Нет данных</td></tr>';

  return `
    <div class="report-panel">
      <h3>${esc(title)}</h3>
      <table>
        <thead><tr><th>${esc(valueLabel)}</th><th>Задач</th><th>Экономия</th><th>Одобрено</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function loadReport() {
  const report = await fetchJson(`/api/report${filterQuery()}`);
  renderToolChart(report.byTool || []);
  renderDepartmentChart(report.byDepartment || []);
  const lowRoi = report.lowRoiTasks.length
    ? report.lowRoiTasks.map(task => `
      <div class="risk-row">
        <strong>${esc(task.title)}</strong>
        <span>${esc(label(departmentLabels, task.department))} / ${esc(task.owner)} / ROI ${task.roiPercent}% / ${task.revisions} правок</span>
      </div>
    `).join('')
    : '<div class="empty">Нет задач с низким ROI или высоким числом правок</div>';

  reportEl.innerHTML = [
    reportTable('По отделам', report.byDepartment, 'Отдел', value => label(departmentLabels, value)),
    reportTable('По AI-инструментам', report.byTool || [], 'Инструмент', toolLabel),
    reportTable('По владельцам', report.byOwner.slice(0, 6), 'Владелец'),
    `<div class="report-panel"><h3>Зоны внимания</h3>${lowRoi}</div>`
  ].join('');
}

async function loadInsights() {
  const insights = await fetchJson(`/api/insights${filterQuery()}`);
  insightsEl.innerHTML = insights.length
    ? insights.map(item => `<div class="insight ${esc(item.level)}">${esc(translateInsight(item.text))}</div>`).join('')
    : '<div class="empty">Инсайтов пока нет</div>';
}

function translateInsight(text) {
  return String(text || '')
    .replaceAll('approval rate', 'доля одобренных задач')
    .replaceAll('Unknown', 'Не указан')
    .replaceAll('legal review', 'юридическое ревью')
    .replaceAll('review', 'ревью')
    .replace(/\bmarketing\b/g, 'маркетинг')
    .replace(/\blegal\b/g, 'юристы')
    .replace(/\bops\b/g, 'операции')
    .replace(/\bfinance\b/g, 'финансы')
    .replace(/\bproduct\b/g, 'продукт');
}

function rowTemplate(task) {
  const saved = Math.max((task.withoutAiMinutes || 0) - (task.withAiMinutes || 0), 0);
  const pluginInfo = listText(task.pluginApplied, id => label(pluginLabels, id));
  const suggestions = (task.pluginSuggestions || []).map(item => translateInsight(item.text)).slice(0, 2).join(' | ');
  const risks = listText(task.riskFlags, riskLabel);
  const canEdit = ['admin', 'manager'].includes(currentUser?.role);
  return `
    <tr>
      <td>${esc(new Date(task.createdAt).toLocaleDateString('ru-RU'))}</td>
      <td>${esc(task.title)}</td>
      <td>${esc(toolLabel(task.aiTool))}</td>
      <td>${esc(label(departmentLabels, task.department))}</td>
      <td>${esc(task.owner)}</td>
      <td>${nf.format(task.withoutAiMinutes || 0)} мин</td>
      <td>${nf.format(task.withAiMinutes || 0)} мин</td>
      <td>${nf.format(saved)} мин</td>
      <td>${task.approved ? 'Одобрено' : 'На проверке'} / ${nf.format(task.revisions)} правок</td>
      <td>${esc(pluginInfo)}</td>
      <td>${esc(risks)}${suggestions ? `<div class="hint">${esc(suggestions)}</div>` : ''}</td>
      <td class="actions">
        <button class="secondary small" type="button" data-action="edit" data-id="${esc(task.id)}" ${canEdit ? '' : 'disabled'}>Изменить</button>
        <button class="danger small" type="button" data-action="delete" data-id="${esc(task.id)}" ${canEdit ? '' : 'disabled'}>Удалить</button>
      </td>
    </tr>
  `;
}

async function loadTasks() {
  tasksCache = await fetchJson(`/api/tasks${filterQuery()}`);
  taskRows.innerHTML = tasksCache.length
    ? tasksCache.map(rowTemplate).join('')
    : '<tr><td colspan="12">Задач по текущим фильтрам нет</td></tr>';
  renderUsagePulse(tasksCache);
  renderRiskMatrix(tasksCache);
}

async function loadRules() {
  if (currentUser?.role !== 'admin') return;
  rulesCache = await fetchJson('/api/rules');
  rulesEl.innerHTML = rulesCache.length
    ? rulesCache.map(rule => `
      <div class="list-row">
        <div>
          <strong>${esc(rule.name)}</strong>
          <span>${rule.enabled ? 'включено' : 'выключено'} / текст: ${esc(rule.matchText || '-')} / отдел: ${esc(label(departmentLabels, rule.matchDepartment, 'любой'))} / риск: ${esc(rule.addRisk || '-')}</span>
        </div>
        <div class="actions">
          <button class="secondary small" data-rule-action="edit" data-id="${esc(rule.id)}" type="button">Изменить</button>
          <button class="danger small" data-rule-action="delete" data-id="${esc(rule.id)}" type="button">Удалить</button>
        </div>
      </div>
    `).join('')
    : '<div class="empty">Правил пока нет</div>';
}

async function loadUsers() {
  if (currentUser?.role !== 'admin') return;
  const users = await fetchJson('/api/users');
  usersEl.innerHTML = users.map(user => `
    <div class="list-row">
      <div>
        <strong>${esc(user.username)}</strong>
        <span>${esc(label(roleLabels, user.role))}${user.department ? ` / ${esc(label(departmentLabels, user.department))}` : ''}</span>
      </div>
      <button class="danger small" data-user-delete="${esc(user.username)}" type="button" ${user.username === 'admin' ? 'disabled' : ''}>Удалить</button>
    </div>
  `).join('');
}

async function loadAudit() {
  const rows = await fetchJson('/api/audit?limit=30');
  auditLogEl.innerHTML = rows.length
    ? rows.map(row => `
      <div class="list-row audit-row">
        <div>
          <strong>${esc(label(actionLabels, row.action, row.action))}</strong>
          <span>${esc(new Date(row.created_at).toLocaleString('ru-RU'))} / ${esc(row.actor)} / ${esc(label(targetLabels, row.target_type, row.target_type))} ${esc(row.target_id || '')}</span>
        </div>
      </div>
    `).join('')
    : '<div class="empty">Журнал действий пуст</div>';
}

async function refreshData() {
  updateExportLinks();
  await Promise.all([loadTasks(), loadMetrics(), loadReport(), loadInsights(), loadAudit(), loadUsage()]);
}

async function refreshAdminData() {
  if (currentUser?.role !== 'admin') return;
  await Promise.all([loadRules(), loadUsers()]);
}

function editTask(id) {
  const task = tasksCache.find(item => item.id === id);
  if (!task) return;
  taskForm.elements.id.value = task.id;
  taskForm.elements.title.value = task.title;
  taskForm.elements.aiTool.value = task.aiTool || 'Unknown';
  taskForm.elements.department.value = task.department;
  taskForm.elements.owner.value = task.owner;
  taskForm.elements.withoutAiMinutes.value = task.withoutAiMinutes;
  taskForm.elements.withAiMinutes.value = task.withAiMinutes;
  taskForm.elements.revisions.value = task.revisions;
  taskForm.elements.approved.value = String(Boolean(task.approved));
  taskForm.elements.riskFlags.value = (task.riskFlags || []).join(', ');
  formTitle.textContent = 'Редактирование задачи';
  saveTaskBtn.textContent = 'Обновить';
  cancelEditBtn.hidden = false;
  setActiveTab('tasks');
  taskForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteTask(id) {
  if (!confirm('Удалить задачу?')) return;
  await fetchJson(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshData();
}

function editRule(id) {
  const rule = rulesCache.find(item => item.id === id);
  if (!rule) return;
  ruleForm.elements.id.value = rule.id;
  ruleForm.elements.name.value = rule.name;
  ruleForm.elements.matchText.value = rule.matchText || '';
  ruleForm.elements.matchDepartment.value = rule.matchDepartment || '';
  ruleForm.elements.minRevisions.value = rule.minRevisions === '' ? '' : rule.minRevisions;
  ruleForm.elements.maxRoiPercent.value = rule.maxRoiPercent === '' ? '' : rule.maxRoiPercent;
  ruleForm.elements.addRisk.value = rule.addRisk || '';
  ruleForm.elements.finding.value = rule.finding || '';
  ruleForm.elements.suggestion.value = rule.suggestion || '';
  ruleForm.elements.enabled.value = String(Boolean(rule.enabled));
  saveRuleBtn.textContent = 'Обновить правило';
  cancelRuleBtn.hidden = false;
}

async function boot() {
  const session = await fetchJson('/api/session');
  setAuthed(session.authenticated, session.user);
  if (session.authenticated) {
    await Promise.all([loadPlugins(), refreshData(), refreshAdminData()]);
  }
}

tabButtons.forEach(button => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(loginForm);
  try {
    const session = await fetchJson('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: formData.get('username'), password: formData.get('password') })
    });
    loginForm.elements.password.value = '';
    setAuthed(true, session.user);
    await Promise.all([loadPlugins(), refreshData(), refreshAdminData()]);
  } catch (err) {
    alert(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetchJson('/api/logout', { method: 'POST' });
  setAuthed(false);
});

taskForm.addEventListener('submit', async e => {
  e.preventDefault();
  const id = taskForm.elements.id.value;
  try {
    await fetchJson(id ? `/api/tasks/${encodeURIComponent(id)}` : '/api/tasks', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskPayloadFromForm())
    });
    resetTaskForm();
    await refreshData();
  } catch (err) {
    alert(err.message);
  }
});

importForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const result = await fetchJson('/api/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: new FormData(importForm).get('csv') })
    });
    importResultEl.textContent = `Импортировано: ${result.imported}. Ошибки: ${result.errors.length ? result.errors.join(' | ') : 'нет'}`;
    importForm.reset();
    await refreshData();
  } catch (err) {
    alert(err.message);
  }
});

usageImportForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const result = await fetchJson('/api/usage/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: new FormData(usageImportForm).get('csv') })
    });
    usageImportResultEl.textContent = `Импортировано usage-событий: ${result.imported}.`;
    usageImportForm.reset();
    await loadUsage();
  } catch (err) {
    alert(err.message);
  }
});

cliStatusForm.addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(cliStatusForm);
  try {
    const result = await fetchJson('/api/usage/cli-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        line: formData.get('line'),
        user: formData.get('user'),
        department: formData.get('department'),
        session: formData.get('session')
      })
    });
    const total = (result.events || []).reduce((sum, event) => sum + Number(event.costUsd || 0), 0);
    cliStatusResultEl.textContent = `Импортировано строк: ${result.imported}. Стоимость: ${usd(total)}.`;
    cliStatusForm.reset();
    await loadUsage();
  } catch (err) {
    alert(err.message);
  }
});

syncUsageBtn.addEventListener('click', async () => {
  syncUsageBtn.disabled = true;
  usageSyncResultEl.textContent = 'Синхронизирую usage...';
  try {
    const result = await fetchJson('/api/usage/sync', { method: 'POST' });
    const text = (result.results || []).map(item => `${item.provider}: ${item.status}${item.imported !== undefined ? `, импортировано ${item.imported}` : ''}${item.message ? ` (${item.message})` : ''}`).join(' | ');
    usageSyncResultEl.textContent = text || 'Синхронизация завершена.';
    await loadUsage();
  } catch (err) {
    usageSyncResultEl.textContent = '';
    alert(err.message);
  } finally {
    syncUsageBtn.disabled = false;
  }
});

ruleForm.addEventListener('submit', async e => {
  e.preventDefault();
  const id = ruleForm.elements.id.value;
  try {
    await fetchJson(id ? `/api/rules/${encodeURIComponent(id)}` : '/api/rules', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rulePayloadFromForm())
    });
    resetRuleForm();
    await Promise.all([loadRules(), refreshData()]);
  } catch (err) {
    alert(err.message);
  }
});

userForm.addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(userForm);
  try {
    await fetchJson('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
        role: formData.get('role'),
        department: formData.get('department')
      })
    });
    userForm.reset();
    await Promise.all([loadUsers(), loadAudit()]);
  } catch (err) {
    alert(err.message);
  }
});

filterForm.addEventListener('input', () => {
  clearTimeout(filterForm._timer);
  filterForm._timer = setTimeout(() => refreshData().catch(err => alert(err.message)), 250);
});

resetFiltersBtn.addEventListener('click', async () => {
  filterForm.reset();
  await refreshData();
});

cancelEditBtn.addEventListener('click', resetTaskForm);
cancelRuleBtn.addEventListener('click', resetRuleForm);

taskRows.addEventListener('click', async e => {
  const button = e.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const id = button.getAttribute('data-id');
  if (button.getAttribute('data-action') === 'edit') editTask(id);
  if (button.getAttribute('data-action') === 'delete') {
    try {
      await deleteTask(id);
    } catch (err) {
      alert(err.message);
    }
  }
});

rulesEl.addEventListener('click', async e => {
  const button = e.target.closest('button[data-rule-action]');
  if (!button) return;
  const id = button.getAttribute('data-id');
  if (button.getAttribute('data-rule-action') === 'edit') editRule(id);
  if (button.getAttribute('data-rule-action') === 'delete') {
    if (!confirm('Удалить правило?')) return;
    await fetchJson(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadRules(), refreshData()]);
  }
});

usersEl.addEventListener('click', async e => {
  const button = e.target.closest('button[data-user-delete]');
  if (!button || button.disabled) return;
  const username = button.getAttribute('data-user-delete');
  if (!confirm(`Удалить пользователя ${username}?`)) return;
  await fetchJson(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  await Promise.all([loadUsers(), loadAudit()]);
});

boot().catch(err => {
  console.error(err);
  alert(`Ошибка загрузки: ${err.message}`);
});
