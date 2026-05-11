const fs = require('fs');
const path = require('path');

function logToFile(msg) {
  const logPath = path.join(__dirname, 'server_log.txt');
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
}

module.exports = { logToFile };
