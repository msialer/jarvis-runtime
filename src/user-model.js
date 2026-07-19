import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { CONFIG } from "./config.js";
import { askKimi } from "./kimi-bridge.js";
import { getRecentMessages } from "./session-manager.js";

const USER_FILE = CONFIG.userModel.filePath;

const MINOR_FACT_PATTERNS = [
  { key: "dni", predicate: /dni/i },
  { key: "zona_horaria", predicate: /zona horaria|timezone|hora de lima/i },
  { key: "formato_respuesta", predicate: /tl;dr|tldr|resumen primero/i },
];

export async function readUserModel() {
  try {
    const content = await readFile(USER_FILE, "utf8");
    return { exists: true, content };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { exists: false, content: "" };
    }
    throw err;
  }
}

export async function writeUserModel(content) {
  await mkdir(path.dirname(USER_FILE), { recursive: true });
  await writeFile(USER_FILE, content);
}

function isMinorFact(fact) {
  if (!CONFIG.userModel.autoApplyMinor) return false;
  const text = `${fact.fact || ""} ${fact.category || ""}`.toLowerCase();
  return MINOR_FACT_PATTERNS.some((p) => p.predicate.test(text));
}

export async function proposeUserModelUpdate(chatJid, project) {
  const recent = await getRecentMessages(chatJid, 30);
  const ownerMessages = recent.filter((m) => m.incoming).map((m) => m.incoming);
  const assistantMessages = recent.filter((m) => m.outgoing).map((m) => m.outgoing);

  if (ownerMessages.length < 3) {
    return { skipped: true, reason: "not enough owner messages" };
  }

  const conversationText = recent
    .map((m) => {
      const who = m.incoming ? "Mauricio" : "Kimi";
      return `${who}: ${m.incoming || m.outgoing || ""}`;
    })
    .join("\n")
    .slice(0, 4000);

  const existing = await readUserModel();
  const prompt = [
    "Eres JARVIS, el EA/CoS de Mauricio. Analiza el siguiente hilo reciente y el perfil de usuario actual.",
    "Extrae máximo 3 hechos o preferencias NUEVAS sobre Mauricio que deban reflejarse en su perfil.",
    "Para cada uno indica:",
    "- category: 'preference', 'fact', 'habit', 'communication', 'goal'",
    "- fact: el hecho en una oración",
    "- confidence: high/medium/low",
    "- sensitivity: low/medium/high (high = médico, financiero detallado, familiar delicado)",
    "",
    "Responde SOLO con un JSON válido de esta forma:",
    '{"updates":[{"category":"...","fact":"...","confidence":"...","sensitivity":"..."}]}',
    "",
    "Si no hay nada nuevo relevante, responde: {\"updates\":[]}",
    "",
    "Perfil actual:",
    existing.content.slice(0, 1500) || "(vacío)",
    "",
    "Hilo reciente:",
    conversationText,
  ].join("\n");

  const response = await askKimi(prompt, {
    projectDir: CONFIG.kimi.projectDir,
    project: project || "default",
  });

  let updates = [];
  try {
    const answer = response.answer || "";
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      updates = Array.isArray(parsed.updates) ? parsed.updates : [];
    }
  } catch (err) {
    console.error("Failed to parse user model update JSON:", err, response.answer);
    return { skipped: true, reason: "parse error" };
  }

  const autoApply = [];
  const propose = [];
  for (const update of updates) {
    if (isMinorFact(update)) {
      autoApply.push(update);
    } else {
      propose.push(update);
    }
  }

  return {
    skipped: false,
    updates,
    autoApply,
    propose,
    filePath: USER_FILE,
  };
}

export async function applyUserModelUpdate(update) {
  const existing = await readUserModel();
  const timestamp = new Date().toISOString();
  const entry = `\n## ${update.category || "general"} — ${timestamp.slice(0, 10)}\n- ${update.fact}\n`;
  const newContent = (existing.content || "# Perfil de usuario — JARVIS\n") + entry;
  await writeUserModel(newContent);
  return { applied: true, filePath: USER_FILE };
}

export function formatUserModelProposal(proposal) {
  if (!proposal || proposal.skipped || proposal.propose.length === 0) return null;
  const lines = [
    "Propuesta de actualización de perfil de usuario:",
    "",
    ...proposal.propose.map((u, i) =>
      `${i + 1}. [${u.category}] ${u.fact} (confianza: ${u.confidence || "?"}, sensibilidad: ${u.sensitivity || "?"})`
    ),
    "",
    "Respondé:",
    "/approve-user-model para aplicar todas",
    "O decime cuáles descartar.",
  ];
  return lines.join("\n");
}
