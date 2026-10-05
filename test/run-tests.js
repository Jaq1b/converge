/**
 * Minimal test runner — no dependencies, no build step.
 *
 * Test modules export `tests`: an array of { name, fn }. A test fails by
 * throwing (node:assert is plenty). Exits non-zero on failure so CI and
 * `npm test` behave.
 */

import { tests as rgaTests } from '../docs/crdt/rga.test.js';
import { tests as oplogTests } from '../docs/crdt/oplog.test.js';
import { tests as undoTests } from '../docs/undo.test.js';
import { tests as relayTests } from '../server/relay.test.js';

const suites = [
  ['docs/crdt/rga.js', rgaTests],
  ['docs/crdt/oplog.js', oplogTests],
  ['docs/undo.js', undoTests],
  ['server/relay.js (end-to-end)', relayTests],
];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
const failures = [];
const startedAt = Date.now();

for (const [suiteName, suiteTests] of suites) {
  console.log(`\n${BOLD}${suiteName}${RESET}`);
  for (const { name, fn } of suiteTests) {
    const t0 = Date.now();
    try {
      await fn();
      const ms = Date.now() - t0;
      passed += 1;
      console.log(`  ${GREEN}✓${RESET} ${name} ${DIM}(${ms}ms)${RESET}`);
    } catch (err) {
      failures.push({ suiteName, name, err });
      console.log(`  ${RED}✗ ${name}${RESET}`);
    }
  }
}

const elapsed = Date.now() - startedAt;

if (failures.length > 0) {
  console.log(`\n${RED}${BOLD}${failures.length} failing${RESET}`);
  for (const { suiteName, name, err } of failures) {
    console.log(`\n${RED}${suiteName} › ${name}${RESET}`);
    console.log(err.message);
    if (err.stack) console.log(DIM + err.stack.split('\n').slice(1, 4).join('\n') + RESET);
  }
  console.log('');
  process.exit(1);
}

console.log(`\n${GREEN}${BOLD}${passed} passing${RESET} ${DIM}(${elapsed}ms)${RESET}\n`);
