#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runSelfTest } from './gate-selftest-lib.mjs';

if (process.platform === 'win32') {
  const local = process.env.LOCALAPPDATA ?? '';
  const user = process.env.USERPROFILE ?? '';
  process.env.PATH = [
    `${local}\\Android\\Sdk\\platform-tools`,
    `${local}\\Android\\Sdk\\emulator`,
    `${user}\\.cargo\\bin`,
    `${local}\\Microsoft\\WinGet\\Packages\\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.1`,
    process.env.PATH ?? '',
  ].join(';');
}

export function validateRegistry(candidate) {
  const problems = [];
  if (!candidate || candidate.version !== 1) problems.push('version must be 1');
  if (!Array.isArray(candidate?.tools) || candidate.tools.length === 0) {
    problems.push('tools must be a non-empty array');
    return problems;
  }

  const ids = new Set();
  for (const [index, tool] of candidate.tools.entries()) {
    const label = `tools[${index}]`;
    if (!tool || typeof tool !== 'object') {
      problems.push(`${label} must be an object`);
      continue;
    }
    if (typeof tool.id !== 'string' || tool.id.trim() === '') problems.push(`${label}.id must be non-empty`);
    else if (ids.has(tool.id)) problems.push(`${label}.id duplicates ${tool.id}`);
    else ids.add(tool.id);
    if (typeof tool.command !== 'string' || tool.command.trim() === '') problems.push(`${label}.command must be non-empty`);
    if (typeof tool.purpose !== 'string' || tool.purpose.trim() === '') problems.push(`${label}.purpose must be non-empty`);
    if (typeof tool.required !== 'boolean') problems.push(`${label}.required must be boolean`);
  }
  return problems;
}

function selfTest() {
  // 자체검사 실패 주입 RED: malformed entries must be rejected by the real validator.
  const valid = {
    version: 1,
    tools: [{ id: 'node', command: 'node --version', purpose: 'project scripts', required: true }],
  };
  const invalidCases = [
    { ...valid, version: 2 },
    { version: 1, tools: [] },
    { version: 1, tools: [{ id: '', command: '', purpose: '', required: 'yes' }] },
    { version: 1, tools: [valid.tools[0], { ...valid.tools[0] }] },
  ];
  const failures = [];
  if (validateRegistry(valid).length !== 0) failures.push('valid registry was rejected');
  invalidCases.forEach((candidate, index) => {
    if (validateRegistry(candidate).length === 0) failures.push(`invalid registry ${index + 1} was accepted (RED case)`);
  });
  return failures;
}

runSelfTest('check-tooling-registry', selfTest);
if (process.argv.includes('--selftest')) {
  console.log('check-tooling-registry selftest: PASS (valid 1 · invalid 4)');
  process.exit(0);
}

const registry = JSON.parse(readFileSync('docs/TOOLING_REGISTRY.json', 'utf8'));
const registryProblems = validateRegistry(registry);
if (registryProblems.length > 0) {
  console.error('check-tooling-registry: invalid registry');
  for (const problem of registryProblems) console.error(`  - ${problem}`);
  process.exit(1);
}

const failures = [];
const skips = [];
for (const tool of registry.tools) {
  const result = spawnSync(tool.command, { shell: true, encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`check-tooling-registry: ${tool.id} PASS`);
  } else if (tool.required) {
    failures.push(`${tool.id}: ${tool.command}`);
    console.log(`check-tooling-registry: ${tool.id} FAIL`);
  } else {
    skips.push(tool.id);
    console.log(`check-tooling-registry: ${tool.id} SKIP (optional tool unavailable)`);
  }
}
if (failures.length) {
  console.error(`check-tooling-registry: required tool(s) missing: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`check-tooling-registry: ${registry.tools.length - skips.length} available · ${skips.length} optional unavailable`);
