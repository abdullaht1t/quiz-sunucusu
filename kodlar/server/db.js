const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const adapter = new FileSync(path.join(dataDir, 'quiz.db.json'));
const db = low(adapter);

db.defaults({
  quizzes: [],
  sessions: [],
  results: [],
  students: [],
  logs: []
}).write();

module.exports = db;
