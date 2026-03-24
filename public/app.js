const taskForm = document.getElementById('taskForm');
const taskRows = document.getElementById('taskRows');
const metricsEl = document.getElementById('metrics');
const pluginsEl = document.getElementById('plugins');

const nf = new Intl.NumberFormat('ru-RU');

function metricCard(label, value) {
  return `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadPlugins() {
  const plugins = await fetchJson('/api/plugins');
  pluginsEl.innerHTML = plugins
    .map(
      plugin => `
      <label class="plugin-item">
        <input type="checkbox" data-plugin-id="${plugin.id}" ${plugin.enabled ? 'checked' : ''} />
        <div>
          <div class="plugin-title">${plugin.name} <span>[${plugin.role}]</span></div>
          <div class="plugin-desc">${plugin.description}</div>
        </div>
      </label>
    `
    )
    .join('');

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
        await loadMetrics();
      } catch (err) {
        e.target.checked = !enabled;
        alert(err.message);
      }
    });
  });
}

async function loadMetrics() {
  const m = await fetchJson('/api/metrics');
  const topPlugins = Object.entries(m.pluginUsage || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id, count]) => `${id}: ${count}`)
    .join(' | ') || '-';

  metricsEl.innerHTML = [
    metricCard('Задач', nf.format(m.totalTasks)),
    metricCard('Сэкономлено (ч)', nf.format(m.savedHours)),
    metricCard('Approval rate', `${m.approvalRate}%`),
    metricCard('Среднее правок', nf.format(m.revisionsAvg)),
    metricCard('Top plugins', topPlugins)
  ].join('');
}

function rowTemplate(task) {
  const saved = Math.max((task.withoutAiMinutes || 0) - (task.withAiMinutes || 0), 0);
  const pluginInfo = (task.pluginApplied || []).join(', ') || '-';
  const suggestions = (task.pluginSuggestions || []).map(item => item.text).slice(0, 2).join(' | ');
  const risks = (task.riskFlags || []).join(', ') || '-';
  return `
    <tr>
      <td>${new Date(task.createdAt).toLocaleDateString('ru-RU')}</td>
      <td>${task.title}</td>
      <td>${task.department}</td>
      <td>${task.owner}</td>
      <td>${nf.format(task.withoutAiMinutes || 0)} мин</td>
      <td>${nf.format(task.withAiMinutes || 0)} мин</td>
      <td>${nf.format(saved)} мин</td>
      <td>${task.approved ? 'OK' : 'Needs review'} / ${task.revisions} правок</td>
      <td>${pluginInfo}</td>
      <td>${risks}${suggestions ? `<div class="hint">${suggestions}</div>` : ''}</td>
    </tr>
  `;
}

async function loadTasks() {
  const tasks = await fetchJson('/api/tasks');
  taskRows.innerHTML = tasks.map(rowTemplate).join('');
}

taskForm.addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(taskForm);
  const payload = {
    title: formData.get('title'),
    department: formData.get('department'),
    owner: formData.get('owner'),
    withoutAiMinutes: Number(formData.get('withoutAiMinutes')),
    withAiMinutes: Number(formData.get('withAiMinutes')),
    revisions: Number(formData.get('revisions') || 0),
    approved: formData.get('approved') === 'true',
    riskFlags: String(formData.get('riskFlags') || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  };

  try {
    await fetchJson('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    taskForm.reset();
    await Promise.all([loadTasks(), loadMetrics()]);
  } catch (err) {
    alert(err.message);
  }
});

Promise.all([loadPlugins(), loadTasks(), loadMetrics()]).catch(err => {
  console.error(err);
  alert(`Ошибка загрузки: ${err.message}`);
});
