'use strict';
const assert = require('node:assert/strict');
const engine = process.argv[2];
assert.ok(['chromium', 'firefox'].includes(engine));
(async () => {
    const browser = await require('playwright')[engine].launch({ headless: true, timeout: 10000,
        ...(process.env.UMININN_BROWSER_EXECUTABLE ? { executablePath: process.env.UMININN_BROWSER_EXECUTABLE } : {}) });
    try {
        const page = await browser.newPage();
        await page.setContent('<p id="probe">ready</p>', { timeout: 5000 });
        assert.equal(await page.locator('#probe').textContent(), 'ready');
        console.log(JSON.stringify({ engine, version: browser.version() }));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
