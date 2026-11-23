const fs = require('node:fs/promises');

async function main() {
  if (process.argv[2] === 'apply') {
    await fs.appendFile('ledger.txt', 'REG-63\n');
    console.log('Registered REG-63');
  } else if (process.argv[2] === 'verify') {
    const first = await fs.writeFile('verification-started.txt', 'started', { flag: 'wx' }).then(() => true, error => {
      if (error.code === 'EEXIST') return false;
      throw error;
    });
    if (first) await new Promise(done => setTimeout(done, 35_000));
    if ((await fs.readFile('ledger.txt', 'utf8')) !== 'REG-63\n') throw new Error('Expected exactly one registration');
    await fs.writeFile('receipt.txt', 'VERIFIED REG-63\n');
    console.log('VERIFIED REG-63');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
