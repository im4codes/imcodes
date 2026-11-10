const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const ERROR = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 50m15s.';
const API_ERROR = 'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF';
const API_RETRY_ERROR = 'API error (attempt 2): stream error: stream ID 1; INTERNAL_ERROR; received from peer';
const STREAM_ERROR = 'The stream was interrupted. Please continue the task you were working on.';
function varint(n) {
  const out = [];
  do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
function field(k, v) {
  if (typeof v === 'number') return Buffer.concat([varint(k * 8), varint(v)]);
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return Buffer.concat([varint(k * 8 + 2), varint(b.length), b]);
}
const message = (...f) => Buffer.concat(f);
function metadata(ms) {
  const timestamp = message(field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1e6));
  return message(field(1, timestamp), field(8, timestamp));
}
function payload(type, body, state = 3) {
  return message(field(1, type), field(4, state), field(type === 14 ? 19 : type === 15 ? 20 : 24, body));
}
function open(home) {
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, CONVERSATION + '.db'));
  db.exec('CREATE TABLE IF NOT EXISTS trajectory_meta(cascade_id TEXT); CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB, step_payload BLOB)');
  if (!db.prepare('SELECT * FROM trajectory_meta').get()) db.prepare('INSERT INTO trajectory_meta VALUES(?)').run(CONVERSATION);
  return db;
}
function insert(db, idx, type, status, at, body, error = null) {
  db.prepare('INSERT OR REPLACE INTO steps VALUES(?,?,?,?,?,?)').run(idx, type, status, metadata(at), error, body);
}
function persist(home, prompt, opts = {}) {
  const db = open(home);
  const at = opts.at ?? Date.now();
  // API and stream-interrupted errors produced by core.appendErrorStep use
  // system_error.error_details.short_error (field 3 -> field 2), whereas the
  // original quota fixture uses its legacy direct text form.
  const usesErrorDetails = opts.error === API_ERROR || opts.error === API_RETRY_ERROR || opts.error === STREAM_ERROR;
  const diagnostic = usesErrorDetails ? field(3,field(2,opts.error)) : field(1,opts.error ?? ERROR);
  if (!db.prepare('SELECT idx FROM steps WHERE idx=11927').get() && !opts.noHistory) {
    insert(db,11927,17,opts.historicalStatus ?? 5,at-86400000,payload(17,diagnostic,opts.historicalStatus ?? 5));
  }
  const idx = (db.prepare('SELECT MAX(idx) AS idx FROM steps').get().idx ?? 11927) + 1;
  insert(db,idx,14,3,at,payload(14,field(2,prompt)));
  const answer = opts.answer ?? 'The actual current answer';
  insert(db,idx+1,15,opts.partial?2:3,at,payload(15,message(field(1,answer),field(8,opts.mismatch?'Other':answer)),opts.partial?2:3));
  if(opts.currentError)insert(db,idx+2,17,5,at,payload(17,diagnostic,5));
  if(opts.laterTool)insert(db,idx+2,132,3,at,payload(132,Buffer.alloc(0)));
  if(opts.errorDetails)db.prepare('UPDATE steps SET error_details=? WHERE idx=?').run(Buffer.from('new failure'),idx+1);
  db.close();
  return {idx,at,answer};
}
module.exports = { CONVERSATION, ERROR, API_ERROR, API_RETRY_ERROR, STREAM_ERROR, field, message, payload, metadata, open, insert, persist };
