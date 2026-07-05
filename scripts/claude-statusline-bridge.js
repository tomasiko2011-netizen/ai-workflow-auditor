#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.ai-workflow-auditor');
const CONFIG_PATH = path.join(CONFIG_DIR, 'statusline-bridge.json');
const LATEST_DIR = path.join(CONFIG_DIR, 'statusline-latest');
const HISTORY_PATH = path.join(CONFIG_DIR, 'statusline-snapshots.jsonl');

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

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u00a0/g, ' ');
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function pick(text, pattern) {
  const match = stripAnsi(text).match(pattern);
  return match ? match[1].trim() : '';
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseSnapshot(rawInput, statuslineOutput) {
  let input = {};
  try {
    input = JSON.parse(rawInput || '{}');
  } catch {
    input = {};
  }

  const cleanOutput = stripAnsi(statuslineOutput);
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || process.env.ECC_SESSION_ID || 'unknown');
  const inputTokens = toNumber(input.context_window?.total_input_tokens);
  const outputTokens = toNumber(input.context_window?.total_output_tokens);
  const model = pick(cleanOutput, /Model:\s*([^|]+)/i)
    || String(input.model?.display_name || input.model?.id || input.model || 'Claude CLI');

  return {
    timestamp: new Date().toISOString(),
    sessionId,
    model,
    cwd: String(input.workspace?.current_dir || input.cwd || ''),
    output: cleanOutput.trim(),
    costUsd: toNumber(pick(cleanOutput, /Cost:\s*\$?([0-9]+(?:\.[0-9]+)?)/i) || pick(cleanOutput, /\$([0-9]+(?:\.[0-9]+)?)/i)),
    sessionPct: toNumber(pick(cleanOutput, /Session:\s*([0-9]+(?:\.[0-9]+)?)%/i)),
    weeklyPct: toNumber(pick(cleanOutput, /Weekly:\s*([0-9]+(?:\.[0-9]+)?)%/i)),
    ctxPct: toNumber(pick(cleanOutput, /Ctx(?:\s+Used)?:\s*([0-9]+(?:\.[0-9]+)?)%/i) || input.context_window?.used_percentage),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function writeSnapshot(snapshot) {
  ensureDir(LATEST_DIR);
  const latestPath = path.join(LATEST_DIR, `${hash(snapshot.sessionId)}.json`);
  const tmp = `${latestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
  fs.renameSync(tmp, latestPath);
  fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function main() {
  const config = readJson(CONFIG_PATH, {});
  const originalCommand = String(config.originalCommand || 'npx -y ccstatusline@latest');

  let rawInput = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    rawInput += chunk;
  });
  process.stdin.on('end', () => {
    const result = spawnSync(originalCommand, {
      input: rawInput,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    try {
      ensureDir(CONFIG_DIR);
      writeSnapshot(parseSnapshot(rawInput, stdout));
    } catch {
      // Statusline must never break Claude CLI rendering.
    }

    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(result.status || 0);
  });
}

main();
