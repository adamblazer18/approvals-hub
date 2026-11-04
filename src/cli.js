// CLI: node src/cli.js create-key "<label>" [project]  |  list-keys  |  revoke-key <id>  |  add-project "<Name>" [#color]
require('./env');
const store = require('./db');
const { PUBLIC_URL } = require('./notify');
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'create-key') {
  const k = store.createKey(a || 'agent', b);
  console.log(`Key for "${k.label}"${k.project ? ' (project ' + k.project + ')' : ''}:\n  ${k.key}\nMCP URL:\n  ${PUBLIC_URL}/mcp/${k.key}\nStore it now; it is not shown again.`);
} else if (cmd === 'list-keys') console.table(store.listKeys());
else if (cmd === 'revoke-key') { store.revokeKey(a); console.log('revoked', a); }
else if (cmd === 'add-project') console.log(store.ensureProject(a, b));
else console.log('usage: create-key <label> [project] | list-keys | revoke-key <id> | add-project <Name> [#color]');
