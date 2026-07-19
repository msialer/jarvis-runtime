import { mkdir, appendFile, writeFile } from "fs/promises";
import path from "path";

const AUDIT_DIR = "/home/ubuntu/projects/jarvis/data/audit";
const AUDIT_LOG = path.join(AUDIT_DIR, "audit-log.ndjson");

function sanitizeJid(jid) {
  if (!jid) return "unknown";
  return jid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatDateDir(date) {
  return date.toISOString().slice(0, 10);
}

async function ensureDirs(dateDir, ...subdirs) {
  for (const sub of subdirs) {
    await mkdir(path.join(AUDIT_DIR, sub, dateDir), { recursive: true });
  }
}

function summarizeAttachment(attachment) {
  if (!attachment) return null;
  return {
    type: attachment.type,
    filename: attachment.filename || attachment.originalName,
    mimetype: attachment.mimetype,
    size: attachment.size,
    transcription: attachment.transcription
      ? `${attachment.transcription.slice(0, 200)}...`
      : null,
    extractedCount: attachment.extracted ? attachment.extracted.fileCount : null,
  };
}

export async function logTurn({
  chatJid,
  authorJid,
  project,
  incoming,
  outgoing,
  prompt,
  kimiResponse,
  attachment,
  durationMs,
}) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const dateDir = formatDateDir(now);
  const jidSafe = sanitizeJid(chatJid);
  const baseName = `${ts}_${jidSafe}`;

  await ensureDirs(dateDir, "prompts", "responses", "errors");

  const promptPath = path.join(AUDIT_DIR, "prompts", dateDir, `${baseName}.txt`);
  const responsePath = path.join(AUDIT_DIR, "responses", dateDir, `${baseName}.txt`);
  const errorPath = path.join(AUDIT_DIR, "errors", dateDir, `${baseName}.txt`);

  const promptTask = writeFile(promptPath, prompt || "(no prompt)");
  const responseTask = writeFile(
    responsePath,
    kimiResponse?.answer || "(no answer)"
  );

  let errorTask = Promise.resolve();
  if (kimiResponse?.error) {
    errorTask = writeFile(
      errorPath,
      `Error: ${kimiResponse.error}\n\nStderr:\n${kimiResponse.stderr || "(no stderr)"}`
    );
  }

  await Promise.all([promptTask, responseTask, errorTask]);

  const entry = {
    timestamp: now.toISOString(),
    chatJid,
    authorJid,
    project,
    incoming: incoming ? incoming.slice(0, 500) : null,
    outgoing: outgoing ? outgoing.slice(0, 500) : null,
    promptLength: prompt ? prompt.length : 0,
    promptPath,
    responsePath,
    errorPath: kimiResponse?.error ? errorPath : null,
    durationMs,
    hasError: !!kimiResponse?.error,
    toolCalls: (kimiResponse?.toolCalls || []).map((tc) => ({
      name: tc.name,
      arguments: typeof tc.arguments === "string" ? tc.arguments.slice(0, 500) : JSON.stringify(tc.arguments).slice(0, 500),
    })),
    attachment: summarizeAttachment(attachment),
  };

  await appendFile(AUDIT_LOG, JSON.stringify(entry) + "\n");
  return entry;
}

export async function logError({ chatJid, authorJid, project, incoming, error }) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const dateDir = formatDateDir(now);
  const jidSafe = sanitizeJid(chatJid);
  const baseName = `${ts}_${jidSafe}`;

  await ensureDirs(dateDir, "errors");
  const errorPath = path.join(AUDIT_DIR, "errors", dateDir, `${baseName}.txt`);
  await writeFile(errorPath, `Error: ${error.message || error}\n\nStack:\n${error.stack || "(no stack)"}`);

  const entry = {
    timestamp: now.toISOString(),
    chatJid,
    authorJid,
    project,
    incoming: incoming ? incoming.slice(0, 500) : null,
    hasError: true,
    errorPath,
    errorMessage: error.message || String(error),
  };

  await appendFile(AUDIT_LOG, JSON.stringify(entry) + "\n");
  return entry;
}
