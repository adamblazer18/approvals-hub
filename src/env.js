// Load .env from the project root if present (Node 22+ built-in).
const path = require('path');
const fs = require('fs');
const f = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
if (fs.existsSync(f)) process.loadEnvFile(f);

// node:sqlite is stable in practice but still flagged experimental on Node 22; keep logs clean.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
