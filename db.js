// Database wrapper for sql.js
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'birdbuddy.db');

let SQL;
let db;

async function initDb() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  return db;
}

function saveDb() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

function reloadDb() {
  if (!SQL) throw new Error('SQL not initialized — call initDb first');
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  }
  return db;
}

function getDb() {
  return db;
}

module.exports = { initDb, saveDb, getDb, reloadDb };
