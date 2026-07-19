import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { CONFIG } from "./config.js";

const HANDOFF_FILE = CONFIG.handoff.filePath;

function getLimaIso() {
  return new Date().toLocaleString("en-US", { timeZone: "America/Lima" });
}

export async function readHandoff() {
  try {
    const content = await readFile(HANDOFF_FILE, "utf8");
    const parsed = parseHandoff(content);
    return { exists: true, content, parsed };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { exists: false, content: "", parsed: null };
    }
    throw err;
  }
}

function parseHandoff(content) {
  const lines = content.split("\n");
  const result = {
    active_project: "",
    objective: "",
    progress: "",
    blockers: "",
    next_steps: [],
    updated_at: "",
  };

  let currentKey = null;
  const buffer = {};

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("# ")) continue; // title
    if (line.startsWith("## ")) {
      const header = line.slice(3).trim().toLowerCase().replace(/\s+/g, "_");
      currentKey = header;
      buffer[currentKey] = [];
      continue;
    }
    if (!currentKey) continue;
    if (line.startsWith("- ") && currentKey === "next_steps") {
      const step = line.slice(2).trim();
      if (step) buffer[currentKey].push(step);
    } else if (line.trim()) {
      buffer[currentKey].push(line);
    }
  }

  for (const [key, value] of Object.entries(buffer)) {
    if (key === "next_steps") {
      result[key] = value;
    } else {
      result[key] = value.join("\n").trim();
    }
  }

  return result;
}

export async function writeHandoff({ activeProject, objective, progress, blockers, nextSteps }) {
  await mkdir(path.dirname(HANDOFF_FILE), { recursive: true });

  const steps = (nextSteps || [])
    .map((s) => `- ${s}`)
    .join("\n") || "- (ninguno definido)";

  const content = `# Handoff — Estado actual

## Active project
${activeProject || "default"}

## Objective
${objective || "(sin objetivo definido)"}

## Progress
${progress || "(sin progreso registrado)"}

## Blockers
${blockers || "(sin blockers)"}

## Next steps
${steps}

## Updated at
${getLimaIso()}
`;

  await writeFile(HANDOFF_FILE, content);
  return { filePath: HANDOFF_FILE, content };
}

export async function clearHandoff() {
  await mkdir(path.dirname(HANDOFF_FILE), { recursive: true });
  await writeFile(
    HANDOFF_FILE,
    `# Handoff — Estado actual

## Active project
default

## Objective
(sin objetivo definido)

## Progress
(sin progreso registrado)

## Blockers
(sin blockers)

## Next steps

## Updated at
${getLimaIso()}
`
  );
  return { filePath: HANDOFF_FILE };
}

export function formatHandoffForPrompt(handoff) {
  if (!handoff || !handoff.exists) return [];
  const p = handoff.parsed;
  if (!p) return [];
  const hasContent =
    p.objective || p.progress || (p.next_steps && p.next_steps.length > 0) || p.blockers;
  if (!hasContent) return [];

  const lines = ["\n--- Estado de handoff pendiente ---"];
  if (p.active_project && p.active_project !== "default") {
    lines.push(`Project activo: ${p.active_project}`);
  }
  if (p.objective) lines.push(`Objetivo: ${p.objective}`);
  if (p.progress) lines.push(`Progreso: ${p.progress}`);
  if (p.blockers) lines.push(`Blockers: ${p.blockers}`);
  if (p.next_steps && p.next_steps.length > 0) {
    lines.push("Próximos pasos:");
    for (const step of p.next_steps) {
      lines.push(`- ${step}`);
    }
  }
  lines.push("--- Fin estado de handoff ---");
  return lines;
}
