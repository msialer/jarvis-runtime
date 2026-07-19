import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs/promises";

const DB_PATH = process.env.JARVIS_LCM_DB || "/home/ubuntu/projects/jarvis/data/jarvis-lcm.db";

// Context assembly policy.
export const FRESH_TAIL_COUNT = 10;
export const LEAF_MIN_MESSAGES = 8;
export const CONDENSE_MIN_LEAVES = 4;
export const MAX_SUMMARY_DEPTH = 2;

let db = null;

export function getDb() {
  if (!db) {
    throw new Error("LCM database not initialized. Call initLcmDb() first.");
  }
  return db;
}

export async function initLcmDb() {
  if (db) return db;
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  createSchema();
  return db;
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      project TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(chat_jid, project)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_results_json TEXT,
      author_jid TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_turn
      ON messages(conversation_id, turn_index);

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      parent_summary_id INTEGER REFERENCES summaries(id) ON DELETE CASCADE,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      start_turn_index INTEGER NOT NULL,
      end_turn_index INTEGER NOT NULL,
      child_summary_ids_json TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_conversation_depth
      ON summaries(conversation_id, depth, end_turn_index);

    CREATE TABLE IF NOT EXISTS summary_children (
      parent_summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
      child_summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
      PRIMARY KEY (parent_summary_id, child_summary_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
      content,
      content_rowid=rowid,
      tokenize='porter'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO fts_messages(rowid, content)
      VALUES (NEW.id, NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO fts_messages(fts_messages, rowid, content)
      VALUES ('delete', OLD.id, OLD.content);
    END;
  `);
}

export function closeLcmDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function getOrCreateConversation(chatJid, project) {
  const select = db.prepare(
    "SELECT id FROM conversations WHERE chat_jid = ? AND project = ?"
  );
  const existing = select.get(chatJid, project);
  if (existing) {
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      nowIso(),
      existing.id
    );
    return existing.id;
  }
  const ts = nowIso();
  const insert = db.prepare(
    "INSERT INTO conversations (chat_jid, project, created_at, updated_at) VALUES (?, ?, ?, ?)"
  );
  const result = insert.run(chatJid, project, ts, ts);
  return result.lastInsertRowid;
}

export function getConversationId(chatJid, project) {
  const row = db
    .prepare("SELECT id FROM conversations WHERE chat_jid = ? AND project = ?")
    .get(chatJid, project);
  return row ? row.id : null;
}

export function appendTurn({
  chatJid,
  project,
  role,
  content,
  toolCalls,
  toolResults,
  authorJid,
  timestamp,
}) {
  const conversationId = getOrCreateConversation(chatJid, project);
  const nextTurnIndex = getNextTurnIndex(conversationId);
  const insert = db.prepare(
    "INSERT INTO messages (conversation_id, turn_index, role, content, tool_calls_json, tool_results_json, author_jid, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const result = insert.run(
    conversationId,
    nextTurnIndex,
    role,
    content || "",
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolResults ? JSON.stringify(toolResults) : null,
    authorJid || null,
    timestamp || nowIso()
  );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
    nowIso(),
    conversationId
  );
  return {
    messageId: result.lastInsertRowid,
    conversationId,
    turnIndex: nextTurnIndex,
  };
}

function getNextTurnIndex(conversationId) {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_index FROM messages WHERE conversation_id = ?"
    )
    .get(conversationId);
  return row.next_index;
}

export function getMessageCount(chatJid, project) {
  const conversationId = getConversationId(chatJid, project);
  if (!conversationId) return 0;
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
    .get(conversationId);
  return row.count;
}

export function getMessages(chatJid, project, options = {}) {
  const conversationId = getConversationId(chatJid, project);
  if (!conversationId) return [];
  const { limit, offset, order = "asc" } = options;
  let sql = "SELECT * FROM messages WHERE conversation_id = ?";
  const args = [conversationId];
  if (order === "desc") {
    sql += " ORDER BY turn_index DESC";
  } else {
    sql += " ORDER BY turn_index ASC";
  }
  if (limit !== undefined) {
    sql += " LIMIT ?";
    args.push(limit);
  }
  if (offset !== undefined) {
    sql += " OFFSET ?";
    args.push(offset);
  }
  const rows = db.prepare(sql).all(...args);
  return rows.map(rowToMessage);
}

export function getMessageRange(chatJid, project, startIndex, endIndex) {
  const conversationId = getConversationId(chatJid, project);
  if (!conversationId) return [];
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND turn_index >= ? AND turn_index <= ? ORDER BY turn_index ASC"
    )
    .all(conversationId, startIndex, endIndex);
  return rows.map(rowToMessage);
}

function rowToMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnIndex: row.turn_index,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : null,
    toolResults: row.tool_results_json ? JSON.parse(row.tool_results_json) : null,
    authorJid: row.author_jid,
    timestamp: row.timestamp,
  };
}

export function buildContext(chatJid, project) {
  const conversationId = getConversationId(chatJid, project);
  if (!conversationId) {
    return { conversationId: null, freshTail: [], summaries: [], messageCount: 0 };
  }

  const totalCount = db
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
    .get(conversationId).count;

  if (totalCount === 0) {
    return { conversationId, freshTail: [], summaries: [], messageCount: 0 };
  }

  const maxTurnIndex = totalCount - 1;
  const freshTailStart = Math.max(0, totalCount - FRESH_TAIL_COUNT);

  const freshTailRows = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND turn_index >= ? ORDER BY turn_index ASC"
    )
    .all(conversationId, freshTailStart);
  const freshTail = freshTailRows.map(rowToMessage);

  const summaries = collectSummariesForRange(
    conversationId,
    0,
    freshTailStart - 1
  );

  return {
    conversationId,
    freshTail,
    summaries,
    messageCount: totalCount,
    freshTailStart,
    maxTurnIndex,
  };
}

function collectSummariesForRange(conversationId, startIndex, endIndex) {
  if (startIndex > endIndex || endIndex < 0) return [];

  const picked = [];
  const pickedIds = new Set();
  let cursor = endIndex;

  while (cursor >= startIndex) {
    // Find the deepest summary that covers the current cursor position.
    const row = db
      .prepare(
        `SELECT * FROM summaries
         WHERE conversation_id = ?
           AND start_turn_index <= ?
           AND end_turn_index >= ?
         ORDER BY depth DESC, end_turn_index DESC
         LIMIT 1`
      )
      .get(conversationId, cursor, cursor);

    if (!row || pickedIds.has(row.id)) {
      cursor--;
      continue;
    }

    picked.push(rowToSummary(row));
    pickedIds.add(row.id);
    cursor = row.start_turn_index - 1;
  }

  // Sort ascending by start index so older context comes first in the prompt.
  picked.sort((a, b) => a.startTurnIndex - b.startTurnIndex);
  return picked;
}

function rowToSummary(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentSummaryId: row.parent_summary_id,
    depth: row.depth,
    content: row.content,
    startTurnIndex: row.start_turn_index,
    endTurnIndex: row.end_turn_index,
    childSummaryIds: row.child_summary_ids_json
      ? JSON.parse(row.child_summary_ids_json)
      : [],
    timestamp: row.timestamp,
  };
}

export function createSummary({
  conversationId,
  parentSummaryId,
  depth,
  content,
  startTurnIndex,
  endTurnIndex,
  childSummaryIds,
}) {
  const insert = db.prepare(
    "INSERT INTO summaries (conversation_id, parent_summary_id, depth, content, start_turn_index, end_turn_index, child_summary_ids_json, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const result = insert.run(
    conversationId,
    parentSummaryId || null,
    depth,
    content,
    startTurnIndex,
    endTurnIndex,
    childSummaryIds ? JSON.stringify(childSummaryIds) : null,
    nowIso()
  );
  const summaryId = result.lastInsertRowid;

  if (childSummaryIds && childSummaryIds.length > 0) {
    const link = db.prepare(
      "INSERT OR IGNORE INTO summary_children (parent_summary_id, child_summary_id) VALUES (?, ?)"
    );
    for (const childId of childSummaryIds) {
      link.run(summaryId, childId);
    }
  }

  return summaryId;
}

export function getUnsummarizedMessageRange(conversationId) {
  const maxSummaryEnd = db
    .prepare(
      "SELECT COALESCE(MAX(end_turn_index), -1) AS max_end FROM summaries WHERE conversation_id = ?"
    )
    .get(conversationId).max_end;

  const totalCount = db
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
    .get(conversationId).count;

  if (totalCount === 0) return null;

  // We only summarize messages that are outside the fresh tail.
  const freshTailStart = Math.max(0, totalCount - FRESH_TAIL_COUNT);
  const startIndex = Math.max(maxSummaryEnd + 1, 0);
  const endIndex = freshTailStart - 1;

  if (startIndex > endIndex) return null;

  const count = endIndex - startIndex + 1;
  return { startIndex, endIndex, count };
}

export function getLeafSummariesReadyForCondensing(conversationId) {
  // Find consecutive leaf summaries at the oldest end that haven't been condensed yet.
  const rows = db
    .prepare(
      `SELECT s.* FROM summaries s
       LEFT JOIN summary_children sc ON sc.child_summary_id = s.id
       WHERE s.conversation_id = ? AND s.depth = 0 AND sc.child_summary_id IS NULL
       ORDER BY s.start_turn_index ASC`
    )
    .all(conversationId);

  if (rows.length < CONDENSE_MIN_LEAVES) return [];

  // Take the oldest consecutive group.
  const group = [rowToSummary(rows[0])];
  for (let i = 1; i < rows.length; i++) {
    const prev = group[group.length - 1];
    const curr = rowToSummary(rows[i]);
    if (curr.startTurnIndex === prev.endTurnIndex + 1) {
      group.push(curr);
      if (group.length >= CONDENSE_MIN_LEAVES) break;
    } else {
      break;
    }
  }

  return group.length >= CONDENSE_MIN_LEAVES ? group : [];
}

export function searchMessages(chatJid, project, query, limit = 5) {
  const conversationId = getConversationId(chatJid, project);
  if (!conversationId) return [];

  const ftsQuery = query
    .replace(/"/g, '""')
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" AND ");

  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN fts_messages f ON m.id = f.rowid
       WHERE m.conversation_id = ? AND fts_messages MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(conversationId, ftsQuery, limit);

  return rows.map(rowToMessage);
}

export function getLcmStats(chatJid, project) {
  const conversationId = getConversationId(chatJid, project);
  if (!conversationId) {
    return { messages: 0, summaries: 0, leafSummaries: 0, condensedSummaries: 0 };
  }
  const messages = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?")
    .get(conversationId).c;
  const summaries = db
    .prepare("SELECT COUNT(*) AS c FROM summaries WHERE conversation_id = ?")
    .get(conversationId).c;
  const leafSummaries = db
    .prepare(
      "SELECT COUNT(*) AS c FROM summaries WHERE conversation_id = ? AND depth = 0"
    )
    .get(conversationId).c;
  const condensedSummaries = db
    .prepare(
      "SELECT COUNT(*) AS c FROM summaries WHERE conversation_id = ? AND depth > 0"
    )
    .get(conversationId).c;
  return { messages, summaries, leafSummaries, condensedSummaries };
}
