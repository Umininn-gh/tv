#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const firefoxOnly = 'Firefox strict autoplay refusal is reported without claiming recovery; a genuine in-frame Play click can start playback';

// Reuse the existing suites. Only layout is filtered: its unrelated geometry,
// touch and hover cases have separate platform-specific coverage limitations.
const suites = [
    { file: 'tests/player-userscript-browser.test.cjs', required: [
        'batch recovery waits for a slow Twitch Play control instead of consuming its attempt on an empty video',
        'standalone userscript controls native and cross-origin media, restores playback, and never reloads players'
    ] },
    { file: 'tests/player-layout-browser.test.cjs', pattern: '^audio focus ', required: [
        'audio focus silences ready audible peers before an unrelated busy frame reply completes',
        'audio focus repairs platform sound resets after acknowledgement and yields to explicit row sound control',
        'audio focus bounds repeated platform unmute repairs and becomes idle after the platform stops',
        'audio focus carries silence to late hidden audio and an ad video replacement without reloading the frame',
        'audio focus waits for a late iframe navigation before opening the enlarged target',
        'audio focus supersedes real bookmark recovery queued behind a delayed acknowledgement',
        'audio focus yields to real bookmark recovery without a late unmute'
    ] },
    { file: 'tests/player-extension-site-compatibility.test.cjs', required: [
        'bookmark restoration schedules one recovery after the completed layout, with rapid restores using only the latest panes',
        'a newer audio focus cancels bookmark recovery even after its task is waiting for an earlier audio command'
    ] }
];

function assess(events, suite, engine) {
    const passes = events.filter(event => event.type === 'test:pass').map(event => event.data);
    const failures = events.filter(event => event.type === 'test:fail').map(event => event.data.name);
    const selected = passes.filter(data => data.skip !== 'test name does not match pattern');
    const skipped = selected.filter(data => data.skip);
    const expectedSkip = data => engine === 'chromium' && suite.file === suites[0].file && data.name === firefoxOnly;
    const unexpected = skipped.filter(data => !expectedSkip(data)).map(data => data.name);
    const passed = selected.filter(data => !data.skip && !data.todo).map(data => data.name);
    const required = [...suite.required, ...(engine === 'firefox' && suite.file === suites[0].file ? [firefoxOnly] : [])];
    const missing = required.filter(name => !passed.includes(name));
    const todos = selected.filter(data => data.todo).map(data => data.name);
    return { ok: passed.length > 0 && !failures.length && !unexpected.length && !missing.length && !todos.length,
        passed, failed: failures, skipped: skipped.map(data => ({ name: data.name, reason: data.skip })),
        unexpectedSkips: unexpected, missing, todos };
}

function parseArgs(args) {
    let engines = ['chromium', 'firefox'], repeat = 1;
    for (let index = 0; index < args.length; index += 2) {
        const value = args[index + 1];
        if (args[index] === '--engine' && ['chromium', 'firefox'].includes(value)) engines = [value];
        else if (args[index] === '--repeat' && /^[1-5]$/.test(value || '')) repeat = Number(value);
        else throw new Error('Usage: node tools/run-browser-regression.cjs [--engine chromium|firefox] [--repeat 1..5]');
    }
    return { engines, repeat };
}

function serializeError(key, value) {
    return value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause } : value;
}

async function main() {
    const { engines, repeat } = parseArgs(process.argv.slice(2));
    process.chdir(root);
    // The public command always opts in, even when its caller forgot the flag.
    process.env.UMININN_BROWSER_TESTS = '1';
    if (process.env.CI && process.env.UMININN_BROWSER_EXECUTABLE) throw new Error('CI must use the pinned Playwright browsers.');
    const output = path.join(root, 'test-results', 'browser');
    fs.mkdirSync(output, { recursive: true });
    let failed = false;
    for (const engine of engines) {
        process.env.UMININN_BROWSER_ENGINE = engine;
        const report = { engine, node: process.version, startedAt: new Date().toISOString(), repeat, suites: [], ok: false };
        try {
            report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
            report.dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
            report.playwright = require('playwright/package.json').version;
            if (report.playwright !== require('../package.json').devDependencies.playwright) throw new Error('Run npm ci to use the locked Playwright version.');
            const { renderUserscript, RELEASE_VERSION } = require('./build-player-userscript.cjs');
            report.userscript = RELEASE_VERSION;
            if (renderUserscript() !== fs.readFileSync(path.join(root, 'userscript/umininn-tv-player.user.js'), 'utf8')) {
                throw new Error('The distributed userscript is stale. Run npm run build:userscript and review its diff.');
            }
            // Launch alone can succeed while a sandboxed content process cannot
            // create a page. Probe real page creation with a hard process bound.
            const probe = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'probe-player-browser.cjs'), engine], {
                cwd: root, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL'
            }));
            report.browser = probe.version;
            report.executableOverride = process.env.UMININN_BROWSER_EXECUTABLE || null;
            console.log(`\n${engine} ${report.browser}; Playwright ${report.playwright}; Userscript ${report.userscript}`);
            for (let iteration = 1; iteration <= repeat; iteration++) for (const suite of suites) {
                const events = [];
                const log = path.join(output, `${engine}-${iteration}-${path.basename(suite.file)}.jsonl`);
                fs.writeFileSync(log, '');
                console.log(`[${engine} ${iteration}/${repeat}] ${suite.file}${suite.pattern ? ' (' + suite.pattern + ')' : ''}`);
                const stream = run({ files: [path.join(root, suite.file)], concurrency: 1,
                    testNamePatterns: suite.pattern ? [suite.pattern] : undefined,
                    timeout: 90000, signal: AbortSignal.timeout(10 * 60 * 1000) });
                for await (const event of stream) {
                    events.push(event);
                    fs.appendFileSync(log, JSON.stringify(event, serializeError) + '\n');
                    if (event.type === 'test:stdout' || event.type === 'test:stderr') process.stdout.write(event.data.message);
                    if (event.type === 'test:fail') console.error('FAIL:', event.data.name, event.data.details?.error);
                }
                const result = { file: suite.file, iteration, ...assess(events, suite, engine) };
                report.suites.push(result);
                console.log(`  ${result.passed.length} passed; ${result.skipped.length} allowed/observed skips; ${result.failed.length} failed`);
                if (!result.ok) console.error(JSON.stringify(result, null, 2));
            }
            report.ok = report.suites.length === suites.length * repeat && report.suites.every(suite => suite.ok);
        } catch (error) {
            report.error = error.stack || String(error);
            console.error(`[${engine}] ${report.error}`);
        } finally {
            report.finishedAt = new Date().toISOString();
            fs.writeFileSync(path.join(output, `${engine}.json`), JSON.stringify(report, null, 2) + '\n');
        }
        failed ||= !report.ok;
    }
    if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { assess, parseArgs, suites, firefoxOnly };
