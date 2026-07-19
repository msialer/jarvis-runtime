import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

const PENDING_FILE = "/home/ubuntu/projects/jarvis/data/pending-approvals.json";
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

let state = null;

async function loadState() {
  if (state) return state;
  try {
    const raw = await readFile(PENDING_FILE, "utf8");
    state = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      state = { approvals: {} };
    } else {
      throw err;
    }
  }
  if (!state.approvals) state.approvals = {};
  return state;
}

async function saveState() {
  await mkdir(path.dirname(PENDING_FILE), { recursive: true });
  await writeFile(PENDING_FILE, JSON.stringify(state, null, 2));
}

function generateId() {
  return "JRV-" + randomBytes(3).toString("base64url").toUpperCase().slice(0, 4);
}

function isExpired(approval) {
  if (approval.status !== "pending") return false;
  const created = new Date(approval.createdAt).getTime();
  return Date.now() - created > EXPIRY_MS;
}

export async function createApproval({ chat, project, toolCalls, context }) {
  const s = await loadState();
  let id;
  do {
    id = generateId();
  } while (s.approvals[id]);

  s.approvals[id] = {
    id,
    chat,
    project,
    toolCalls,
    context,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await saveState();
  return s.approvals[id];
}

export async function getApproval(id) {
  const s = await loadState();
  return s.approvals[id] || null;
}

export async function approveApproval(id, approver) {
  const s = await loadState();
  const a = s.approvals[id];
  if (!a || a.status !== "pending" || isExpired(a)) return null;
  a.status = "approved";
  a.approvedBy = approver;
  a.approvedAt = new Date().toISOString();
  await saveState();
  return a;
}

export async function denyApproval(id, approver) {
  const s = await loadState();
  const a = s.approvals[id];
  if (!a || a.status !== "pending" || isExpired(a)) return null;
  a.status = "denied";
  a.deniedBy = approver;
  a.deniedAt = new Date().toISOString();
  await saveState();
  return a;
}

export async function listPending() {
  const s = await loadState();
  return Object.values(s.approvals).filter((a) => a.status === "pending");
}

export async function listExpired() {
  const s = await loadState();
  return Object.values(s.approvals).filter(isExpired);
}

export async function removeApproval(id) {
  const s = await loadState();
  delete s.approvals[id];
  await saveState();
}

export async function cleanupExpired() {
  const expired = await listExpired();
  for (const a of expired) {
    delete state.approvals[a.id];
  }
  if (expired.length > 0) await saveState();
  return expired;
}
