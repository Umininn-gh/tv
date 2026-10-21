#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(name =>
    /^(player-.*|layout-bookmarks|browser-regression-runner)\.test\.cjs$/.test(name) &&
    !name.includes('-browser.') && name !== 'player-extension-site-compatibility.test.cjs'
).sort().map(name => 'tests/' + name);
if (!files.length) throw new Error('No player unit tests found.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root, stdio: 'inherit', env: { ...process.env, UMININN_BROWSER_TESTS: '0' }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
