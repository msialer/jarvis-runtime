import { readFile, writeFile, readdir, mkdir, copyFile, stat } from "fs/promises";
import path from "path";

const POLICIES_DIR = "/home/ubuntu/projects/jarvis/vault/memory/procedural/policies";
const BACKUPS_DIR = path.join(POLICIES_DIR, "backups");

async function ensureDirs() {
  await mkdir(POLICIES_DIR, { recursive: true });
  await mkdir(BACKUPS_DIR, { recursive: true });
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
}

function policyPath(name) {
  return path.join(POLICIES_DIR, `${normalizeName(name)}.md`);
}

export async function listPolicies() {
  await ensureDirs();
  const entries = await readdir(POLICIES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.replace(/\.md$/, ""))
    .sort();
}

export async function getPolicy(name) {
  await ensureDirs();
  const p = policyPath(name);
  try {
    const content = await readFile(p, "utf8");
    return { exists: true, name: normalizeName(name), content };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { exists: false, name: normalizeName(name), content: "" };
    }
    throw err;
  }
}

export async function updatePolicy(name, content, reason = "") {
  await ensureDirs();
  const normalized = normalizeName(name);
  const p = policyPath(normalized);

  // Backup current version if it exists.
  let previousContent = "";
  let hasBackup = false;
  try {
    previousContent = await readFile(p, "utf8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(BACKUPS_DIR, `${normalized}-${timestamp}.md`);
    await copyFile(p, backupPath);
    hasBackup = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const header = `# Policy: ${normalized}\n\n`;
  const footer = reason ? `\n\n_Last updated: ${new Date().toISOString()} — ${reason}_\n` : "";
  const fullContent = content.startsWith("# ") ? content + footer : header + content + footer;

  await writeFile(p, fullContent);
  return {
    name: normalized,
    path: p,
    previousContent,
    newContent: fullContent,
    hasBackup,
  };
}

export async function revertPolicy(name) {
  const normalized = normalizeName(name);
  const p = policyPath(normalized);

  const backups = await listBackups(normalized);
  if (backups.length === 0) {
    throw new Error(`No hay backups para la policy ${normalized}`);
  }

  const latestBackup = backups[0];
  await copyFile(latestBackup.path, p);
  return { name: normalized, path: p, restoredFrom: latestBackup.path };
}

export async function listBackups(name) {
  await ensureDirs();
  const normalized = normalizeName(name);
  try {
    const entries = await readdir(BACKUPS_DIR, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const match = entry.name.match(new RegExp(`^${normalized}-(.+)\\.md$`));
      if (!match) continue;
      const backupPath = path.join(BACKUPS_DIR, entry.name);
      const info = await stat(backupPath);
      backups.push({
        name: entry.name,
        path: backupPath,
        timestamp: match[1],
        mtime: info.mtime,
      });
    }
    return backups.sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function loadAllPolicies() {
  const names = await listPolicies();
  const policies = [];
  for (const name of names) {
    const policy = await getPolicy(name);
    if (policy.exists) {
      policies.push(policy);
    }
  }
  return policies;
}

export function formatPoliciesList(policies) {
  if (policies.length === 0) return "No hay policies registradas.";
  return ["Policies activas:", ...policies.map((p) => `- ${p}`)].join("\n");
}
