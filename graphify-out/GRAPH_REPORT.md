# Graph Report - .  (2026-06-11)

## Corpus Check
- Corpus is ~2,139 words - fits in a single context window. You may not need a graph.

## Summary
- 56 nodes · 60 edges · 6 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_HTTP Server and Routing|HTTP Server and Routing]]
- [[_COMMUNITY_Frontend Dashboard UI|Frontend Dashboard UI]]
- [[_COMMUNITY_Package Manifest|Package Manifest]]
- [[_COMMUNITY_HTML Entry and README Docs|HTML Entry and README Docs]]
- [[_COMMUNITY_Plugin State Data Store|Plugin State Data Store]]
- [[_COMMUNITY_Plugin Execution System|Plugin Execution System]]

## God Nodes (most connected - your core abstractions)
1. `pluginState` - 4 edges
2. `normalizePluginState()` - 4 edges
3. `fetchJson()` - 4 edges
4. `Role-Based Plugins` - 4 edges
5. `executePlugins()` - 3 edges
6. `loadMetrics()` - 3 edges
7. `AI Workflow Auditor MVP` - 3 edges
8. `scripts` - 2 edges
9. `AVAILABLE_PLUGINS` - 2 edges
10. `metricCard()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `readStore()` --calls--> `normalizePluginState()`  [EXTRACTED]
  server.js → plugins.js
- `AI Task Submission Form` --implements--> `AI Workflow Auditor MVP`  [EXTRACTED]
  public/index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Built-in role-based plugin set** — readme_marketing_quality_plugin, readme_legal_compliance_plugin, readme_manager_roi_plugin [INFERRED]

## Communities (6 total, 0 thin omitted)

### Community 0 - "HTTP Server and Routing"
Cohesion: 0.12
Nodes (7): { AVAILABLE_PLUGINS, normalizePluginState, executePlugins }, DB_PATH, fs, http, path, PUBLIC_DIR, server

### Community 1 - "Frontend Dashboard UI"
Cohesion: 0.23
Nodes (10): fetchJson(), loadMetrics(), loadPlugins(), loadTasks(), metricCard(), metricsEl, nf, pluginsEl (+2 more)

### Community 2 - "Package Manifest"
Cohesion: 0.25
Nodes (7): description, main, name, private, scripts, start, version

### Community 3 - "HTML Entry and README Docs"
Cohesion: 0.29
Nodes (7): AI Task Submission Form, AI Workflow Auditor MVP, Legal Compliance Plugin, Manager ROI Plugin, Marketing Quality Plugin, Role-Based Plugins, AI Time Saving Metrics

### Community 4 - "Plugin State Data Store"
Cohesion: 0.33
Nodes (5): pluginState, legal-compliance, manager-roi, marketing-quality, tasks

### Community 5 - "Plugin Execution System"
Cohesion: 0.40
Nodes (4): AVAILABLE_PLUGINS, executePlugins(), normalizePluginState(), readStore()

## Knowledge Gaps
- **27 isolated node(s):** `tasks`, `marketing-quality`, `legal-compliance`, `manager-roi`, `name` (+22 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `tasks`, `marketing-quality`, `legal-compliance` to the rest of the system?**
  _27 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `HTTP Server and Routing` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._