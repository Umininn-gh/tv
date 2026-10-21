'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, parseArgs, suites, firefoxOnly } = require('../tools/run-browser-regression.cjs');
const pass = (name, extra = {}) => ({ type: 'test:pass', data: { name, ...extra } });
const suite = { file: 'fixture.test.cjs', required: ['critical case'] };

test('regression gate rejects an empty run, missing coverage, failures, TODOs and unavailable-browser skips', () => {
    for (const events of [[], [pass('something else')], [pass('critical case', { skip: 'browser unavailable' })],
        [pass('critical case', { todo: true })], [pass('critical case'), { type: 'test:fail', data: { name: 'late failure' } }]]) {
        assert.equal(assess(events, suite, 'chromium').ok, false);
    }
    assert.equal(assess([pass('critical case'), pass('unrelated geometry', { skip: 'test name does not match pattern' })], suite, 'chromium').ok, true);
});

test('regression gate allows only the named Firefox-policy skip on Chromium and requires it on Firefox', () => {
    const events = suites[0].required.map(name => pass(name));
    assert.equal(assess([...events, pass(firefoxOnly, { skip: true })], suites[0], 'chromium').ok, true);
    assert.equal(assess([...events, pass('unexpected skip', { skip: true })], suites[0], 'chromium').ok, false);
    assert.equal(assess(events, suites[0], 'firefox').ok, false);
    assert.equal(assess([...events, pass(firefoxOnly)], suites[0], 'firefox').ok, true);
});

test('regression command defaults to both engines and rejects mistyped engines and repeat counts', () => {
    assert.deepEqual(parseArgs([]), { engines: ['chromium', 'firefox'], repeat: 1 });
    assert.deepEqual(parseArgs(['--engine', 'firefox', '--repeat', '2']), { engines: ['firefox'], repeat: 2 });
    for (const args of [['--engine', 'edge'], ['--repeat', '0'], ['--repeat', '2x'], ['--engine']]) assert.throws(() => parseArgs(args));
});
