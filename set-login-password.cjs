const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

async function main() {
    const generate = process.argv.includes('--generate');
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    let password;
    try {
        password = generate ? crypto.randomBytes(12).toString('base64url') : await input.question('New website password: ');
    } finally {
        input.close();
    }
    if (!password) throw new Error('Password cannot be empty');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + ':' + password, 'utf8').digest('hex');
    const config = {
        passwordSalt: salt,
        passwordHash: hash,
        storageKey: 'umininn-tv-login-v1'
    };
    fs.writeFileSync(path.join(__dirname, 'login-config.js'),
        '// Convenience gate only. This public hash is not server-side authentication.\n' +
        'window.TV_LOGIN_CONFIG = Object.freeze(' + JSON.stringify(config, null, 4) + ');\n');
    console.log('Updated login-config.js. Commit and deploy this file to apply the change.');
    if (generate) console.log('Website password: ' + password);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
