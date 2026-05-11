const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'tasks_db.json');
const raw = fs.readFileSync(DB_PATH, 'utf-8');
const db = JSON.parse(raw);
const keys = ['rooms', 'notifications', 'ratings', 'broadcasts', 'broadcast_requests', 'connection_stages', 'reviews', 'disputes', 'users', 'user_skills', 'match_requests'];
keys.forEach(k => {
  if (!db[k]) db[k] = [];
});
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
console.log('Database keys verified and saved.');
