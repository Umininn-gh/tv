'use strict';

// Reuse the existing trusted-pointer interaction regressions. These exercise
// cancellation and commit boundaries alongside the shared sizing/preview tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const names = new Set([
    'corner resize previews four outward/inward directions and commits only once on release without interrupting media',
    'corner resize uses the dominant normalized start pitch across multiple cells, including release outside the pane',
    'handle clicks and subthreshold drags do not grow a player, while center and keyboard activation remain usable',
    'corner resize cancellation clears its preview and cannot leak a commit into the next mode or selection',
    'a second pointer cannot steal or finish a corner resize and changing focus keeps exactly one enlarged player',
    'real viewport jitter preserves an enlarged layout while a large portrait resize can still adapt',
    'a mouse button chord cannot commit a corner resize after the primary button has been released',
    'a pane change and pointerup in the same task cannot commit a resize using stale start geometry'
]);
const selected = new Set();
const selectedTest = Object.assign((name, ...args) => {
    if (!names.has(name)) return;
    assert.equal(selected.has(name), false, 'unique legacy interaction case');
    selected.add(name); return test(name, ...args);
}, { before: test.before, after: test.after });
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile);
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n})',
    { filename: harnessFile })(name => name === 'node:test' ? selectedTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
assert.deepEqual([...selected].sort(), [...names].sort(), 'all reviewed resize-interaction cases must still be registered');
