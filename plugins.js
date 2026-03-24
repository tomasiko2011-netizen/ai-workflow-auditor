function includesAny(text, terms) {
  const haystack = String(text || '').toLowerCase();
  return terms.some(term => haystack.includes(term));
}

const AVAILABLE_PLUGINS = [
  {
    id: 'marketing-quality',
    role: 'marketing',
    name: 'Marketing Quality Plugin',
    description: 'Проверяет бренд-безопасность и гипотезы для маркетинговых задач.',
    run(task) {
      const joined = `${task.title} ${(task.riskFlags || []).join(' ')}`;
      const findings = [];
      const suggestions = [];
      const extraRisks = [];

      if (includesAny(joined, ['campaign', 'ad', 'promo', 'маркет', 'реклама'])) {
        if (!(task.riskFlags || []).includes('brand-safety')) {
          extraRisks.push('brand-safety');
          findings.push('Добавлен риск brand-safety для маркетинговой задачи.');
        }
        suggestions.push('Проверьте соответствие бренд-гайду перед публикацией.');
      }

      return { findings, suggestions, extraRisks };
    }
  },
  {
    id: 'legal-compliance',
    role: 'legal',
    name: 'Legal Compliance Plugin',
    description: 'Находит задачи с признаками юридических и комплаенс рисков.',
    run(task) {
      const joined = `${task.title} ${(task.riskFlags || []).join(' ')}`;
      const findings = [];
      const suggestions = [];
      const extraRisks = [];

      if (includesAny(joined, ['contract', 'agreement', 'policy', 'terms', 'договор', 'политика'])) {
        if (!(task.riskFlags || []).includes('compliance')) {
          extraRisks.push('compliance');
          findings.push('Добавлен риск compliance: найден юридический контекст.');
        }
        suggestions.push('Попросите legal review перед отправкой клиенту.');
      }

      if (includesAny(joined, ['client-data', 'pii', 'персональ'])) {
        if (!(task.riskFlags || []).includes('pii')) {
          extraRisks.push('pii');
          findings.push('Добавлен риск pii: найдены признаки персональных данных.');
        }
      }

      return { findings, suggestions, extraRisks };
    }
  },
  {
    id: 'manager-roi',
    role: 'manager',
    name: 'Manager ROI Plugin',
    description: 'Отмечает задачи с низким ROI или высоким числом правок.',
    run(task) {
      const findings = [];
      const suggestions = [];
      const extraRisks = [];

      const before = Number(task.withoutAiMinutes) || 0;
      const after = Number(task.withAiMinutes) || 0;
      const revisions = Number(task.revisions) || 0;
      const saved = Math.max(before - after, 0);

      if (before > 0 && saved / before < 0.2) {
        findings.push('Низкая экономия времени: менее 20%.');
        suggestions.push('Перепроверьте промпт/процесс: ROI ниже целевого.');
      }

      if (revisions >= 3) {
        if (!(task.riskFlags || []).includes('quality-drift')) {
          extraRisks.push('quality-drift');
        }
        findings.push('Много правок: риск деградации качества.');
      }

      return { findings, suggestions, extraRisks };
    }
  }
];

function normalizePluginState(input) {
  const current = input && typeof input === 'object' ? input : {};
  const state = {};
  for (const plugin of AVAILABLE_PLUGINS) {
    state[plugin.id] = current[plugin.id] !== false;
  }
  return state;
}

function executePlugins(task, pluginState) {
  const state = normalizePluginState(pluginState);
  const mergedRisks = [...(task.riskFlags || [])];
  const findings = [];
  const suggestions = [];
  const applied = [];

  for (const plugin of AVAILABLE_PLUGINS) {
    if (!state[plugin.id]) continue;
    const result = plugin.run({ ...task, riskFlags: mergedRisks });
    applied.push(plugin.id);

    for (const flag of result.extraRisks || []) {
      if (!mergedRisks.includes(flag)) {
        mergedRisks.push(flag);
      }
    }
    for (const item of result.findings || []) {
      findings.push({ pluginId: plugin.id, text: item });
    }
    for (const item of result.suggestions || []) {
      suggestions.push({ pluginId: plugin.id, text: item });
    }
  }

  return {
    riskFlags: mergedRisks,
    pluginFindings: findings,
    pluginSuggestions: suggestions,
    pluginApplied: applied
  };
}

module.exports = {
  AVAILABLE_PLUGINS,
  normalizePluginState,
  executePlugins
};
