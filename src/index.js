import { mkdir, appendFile, readFile, writeFile, unlink, readdir, stat, copyFile } from "fs/promises";
import path from "path";
import { startBaileys, sendWhatsAppMessage, DOWNLOADS_DIR } from "./baileys.js";
import { transcribeAudio } from "./audio-transcriber.js";
import { isArchive, extractArchive } from "./archive-extractor.js";
import {
  listPolicies,
  getPolicy,
  updatePolicy,
  revertPolicy,
  formatPoliciesList,
} from "./policy-manager.js";
import { logTurn, logError } from "./audit-logger.js";
import { searchMemPalace } from "./tools/mempalace.js";
import { checkpointTurn, fetchMemoryContext } from "./memory-checkpoint.js";
import {
  initLcmDb,
  getDb,
  appendTurn,
  buildContext as buildLcmContext,
  getUnsummarizedMessageRange,
  getLeafSummariesReadyForCondensing,
  createSummary,
  getMessageRange,
  searchMessages,
  FRESH_TAIL_COUNT,
  LEAF_MIN_MESSAGES,
  CONDENSE_MIN_LEAVES,
} from "./lcm.js";
import { summarizeLeaf, summarizeCondensed } from "./lcm-summarizer.js";
import {
  askKimi,
  summarizeConversation,
  buildToolResultPrompt,
} from "./kimi-bridge.js";
import { evaluateTool, formatToolForDisplay } from "./tool-router.js";
import {
  createApproval,
  approveApproval,
  denyApproval,
  getApproval,
  removeApproval,
  listExpired,
  cleanupExpired,
} from "./pending-approvals.js";
import { executeTool } from "./tool-executor.js";
import { listMetrics } from "./tools/metrics.js";
import { startScheduler, listEvents, addEvent, cancelEvent } from "./scheduler.js";
import { CONFIG } from "./config.js";
import { readHandoff, writeHandoff, clearHandoff } from "./handoff.js";
import { generateDailyLog, shouldGenerateDailyLog } from "./daily-log.js";
import {
  proposeUserModelUpdate,
  formatUserModelProposal,
  applyUserModelUpdate,
} from "./user-model.js";
import {
  getActiveProject,
  setActiveProject,
  getSession,
  updateSession,
  resetSession,
  bumpMessageCount,
  bumpOwnerTurnCount,
  getOwnerTurnCount,
  resetOwnerTurnCount,
  shouldCompact,
  applyCompaction,
  getSummary,
  listProjectSessions,
  addRecentMessage,
  getRecentMessages,
  updateConversationState,
  getConversationState,
  clearPendingAction,
} from "./session-manager.js";
import {
  listProjects,
  resolveProjectDir,
  projectExists,
  getDefaultProject,
} from "./projects.js";

const CONVERSATION_LOG =
  "/home/ubuntu/projects/jarvis/data/conversations/whatsapp-log.ndjson";
let sock = null;
let lastMorningBriefDate = null;
let lastInboxCheckAt = null; // { date: Lima date string, hour: number }
let lastFollowUpCheckDate = null;
let lastDailyLogDate = null;

async function logConversation(entry) {
  await mkdir(path.dirname(CONVERSATION_LOG), { recursive: true });
  await appendFile(CONVERSATION_LOG, JSON.stringify(entry) + "\n");
}

function getLimaDate() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Lima" })
  );
}

function formatMetrics(metrics) {
  if (!metrics || metrics.length === 0) return "No hay metricas registradas.";
  return metrics
    .map(
      (m) =>
        `- ${m.domain}.${m.metric_name}: ${m.count} registros (ultimo: ${m.last_recorded})`
    )
    .join("\n");
}

function formatProjectName(key) {
  if (!key) return "";
  return key
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function markdownToWhatsApp(text) {
  if (!text) return text;
  // Convert Markdown bold **text** to WhatsApp bold *text*.
  // Process non-greedy pairs to avoid merging separate bold sections.
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

// Patterns that indicate raw debug/technical output that should not be
// forwarded to WhatsApp as-is.
const DEBUG_LINE_PATTERNS = [
  /^Traceback\b/,
  /^\s*File\s+"[^"]+"\s*,\s*line\s+\d+/,
  /^ModuleNotFoundError:/,
  /^ImportError:/,
  /^\{\"jsonrpc\":\s*\"2\.0\"/,
  /^\s*\"isError\":\s*true/,
  /^\s*\"error\":\s*/,
  /^drwxrwxr-x/,
  /^total\s+\d+$/,
  /^no such column:/,
  /^Command failed:/,
  /^\s*at\s+\S+\s+\(/,
];

function isDebugLine(line) {
  return DEBUG_LINE_PATTERNS.some((re) => re.test(line));
}

function sanitizeForWhatsApp(text) {
  if (!text) return text;
  const lines = text.split("\n");
  const clean = [];
  let removedAny = false;
  for (const line of lines) {
    if (isDebugLine(line)) {
      removedAny = true;
      continue;
    }
    clean.push(line);
  }
  const result = clean.join("\n").trim();
  if (removedAny && result.length < 20) {
    return "Hubo un error técnico al generar la respuesta. Ya fue registrado; por favor intentá de nuevo o pedime detalles.";
  }
  return result;
}

async function sendReply(to, text) {
  const sanitized = sanitizeForWhatsApp(text);
  const formatted = markdownToWhatsApp(sanitized);
  await sendWhatsAppMessage(sock, to, formatted);
}

// Check if the owner sent a message to the home group in the last N minutes.
// Used to avoid interrupting an active conversation with proactive checks.
async function hasRecentOwnerActivity(minutes = 20) {
  try {
    const data = await readFile(CONVERSATION_LOG, "utf8");
    const lines = data.trim().split("\n").filter(Boolean).slice(-50);
    const cutoff = Date.now() - minutes * 60 * 1000;
    for (const line of lines.reverse()) {
      try {
        const entry = JSON.parse(line);
        if (
          entry.isOwner &&
          entry.sender === CONFIG.whatsapp.homeGroup &&
          new Date(entry.timestamp).getTime() > cutoff
        ) {
          return true;
        }
      } catch {
        // Ignore malformed lines.
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to check recent activity:", err);
    }
  }
  return false;
}

async function runSkillForOwner(to, skillName, header) {
  const activeProject = await getActiveProject(to);
  const projectDir = resolveProjectDir(activeProject);
  const session = await getSession(to, activeProject);
  const palace = await searchMemPalace(skillName, 3);
  const availableProjects = await listProjects();
  const lcmContext = buildLcmContext(to, activeProject);

  const response = await askKimi(`/skill:${skillName}`, {
    projectDir,
    project: activeProject,
    availableProjects,
    summary: session.summary,
    lcmContext,
    sender: to,
    isOwner: true,
    memPalaceResults: palace.results || [],
  });

  const text = response.error
    ? `Error consultando a Kimi: ${response.error}`
    : response.answer;
  const fullText = header ? `${header}\n\n${text}` : text;
  await sendReply(to, fullText);
  await recordOutgoing(to, fullText, activeProject);
}

async function runMorningBrief(to) {
  await runSkillForOwner(to, "morning", "Morning brief");
}

async function runInboxCheck(to) {
  const activeProject = await getActiveProject(to);
  const projectDir = resolveProjectDir(activeProject);
  const session = await getSession(to, activeProject);
  const palace = await searchMemPalace("inbox-check", 3);
  const availableProjects = await listProjects();
  const lcmContext = buildLcmContext(to, activeProject);

  const response = await askKimi(`/skill:inbox-check`, {
    projectDir,
    project: activeProject,
    availableProjects,
    summary: session.summary,
    lcmContext,
    sender: to,
    isOwner: true,
    memPalaceResults: palace.results || [],
  });

  const text = response.error
    ? `Error consultando a Kimi: ${response.error}`
    : response.answer;

  // Inbox check is silent unless there is something actionable to report.
  if (!text || text.includes("NO_ALERT") || /sin novedades|inbox calm|bandeja tranquila/i.test(text)) {
    console.log("Inbox check: no actionable emails, skipping notification.");
    return;
  }

  await sendReply(to, text);
  await recordOutgoing(to, text, activeProject);
}

async function runFollowUpCheck(to) {
  await runSkillForOwner(to, "follow-up-check", "Follow-ups");
}

async function maintainLcm(chatJid, projectKey) {
  try {
    const conversationId = buildLcmContext(chatJid, projectKey).conversationId;
    if (!conversationId) return;

    // 1. Create leaf summaries for unsummarized messages outside the fresh tail.
    let range = getUnsummarizedMessageRange(conversationId);
    while (range && range.count >= LEAF_MIN_MESSAGES) {
      const messages = getMessageRange(chatJid, projectKey, range.startIndex, range.endIndex);
      const summaryText = await summarizeLeaf(messages);
      if (!summaryText) break;

      createSummary({
        conversationId,
        depth: 0,
        content: summaryText,
        startTurnIndex: range.startIndex,
        endTurnIndex: range.endIndex,
      });
      console.log(
        `LCM leaf summary created for ${chatJid}/${projectKey} (turns ${range.startIndex}-${range.endIndex})`
      );

      range = getUnsummarizedMessageRange(conversationId);
    }

    // 2. Condense consecutive leaf summaries.
    let leaves = getLeafSummariesReadyForCondensing(conversationId);
    while (leaves.length >= CONDENSE_MIN_LEAVES) {
      const condensedText = await summarizeCondensed(leaves);
      if (!condensedText) break;

      const startTurnIndex = Math.min(...leaves.map((s) => s.startTurnIndex));
      const endTurnIndex = Math.max(...leaves.map((s) => s.endTurnIndex));
      createSummary({
        conversationId,
        depth: 1,
        content: condensedText,
        startTurnIndex,
        endTurnIndex,
        childSummaryIds: leaves.map((s) => s.id),
      });
      console.log(
        `LCM condensed summary created for ${chatJid}/${projectKey} (turns ${startTurnIndex}-${endTurnIndex})`
      );

      leaves = getLeafSummariesReadyForCondensing(conversationId);
    }
  } catch (err) {
    console.error("LCM maintenance failed:", err);
  }
}

// Legacy compact/read functions kept as thin fallbacks.
async function maybeCompact(chatJid, projectKey) {
  // LCM maintenance runs after each turn; legacy compact is no longer needed.
  return maintainLcm(chatJid, projectKey);
}

async function handleProjectCommand(sender, args) {
  const available = await listProjects();

  if (args.length === 0) {
    const active = await getActiveProject(sender);
    const sessions = await listProjectSessions(sender);
    const lines = [
      `Project activo: ${formatProjectName(active)}`,
      "",
      "Projects disponibles:",
      ...available.map(
        (p) => `- ${formatProjectName(p)}${p === active ? " (activo)" : ""}`
      ),
      "",
      "Sesiones guardadas:",
      ...sessions.map(
        (s) =>
          `- ${formatProjectName(s.key)}: ${s.messageCount} msgs${
            s.hasSummary ? " (con resumen)" : ""
          }`
      ),
    ];
    await sendReply(sender, lines.join("\n"));
    return true;
  }

  // Create a new project: /project create <name> [description...]
  if (args[0].toLowerCase() === "create") {
    if (args.length < 2) {
      await sendReply(sender, "Uso: /project create <nombre> [descripcion]");
      return true;
    }

    const projectKey = args[1].toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(projectKey)) {
      await sendReply(
        sender,
        "Nombre de project invalido. Usa solo letras, numeros, guiones y guiones bajos."
      );
      return true;
    }

    if (await projectExists(projectKey)) {
      await sendReply(
        sender,
        `El project ${formatProjectName(projectKey)} ya existe.`
      );
      return true;
    }

    let description = args.slice(2).join(" ") || `Project ${projectKey}`;
    description = description.replace(/^["']|["']$/g, "");
    const projectDir = resolveProjectDir(projectKey);
    await mkdir(projectDir, { recursive: true });

    const kimiContent = `# JARVIS — ${description}

## Identidad

Eres el project **${description}** de Mauricio dentro de JARVIS.

## Principios

1. **Registro obsesivo**: datos relevantes van a la base de metricas o a MemPalace.
2. **Contexto persistente**: consulta MemPalace antes de responder.
3. **Propose → Approve**: no ejecutes acciones irreversibles sin aprobacion explicita.

## Formato

- Respuestas concisas.
- Sin emojis.
- Cita fuentes cuando uses MemPalace.
`;
    await writeFile(path.join(projectDir, "KIMI.md"), kimiContent);

    await setActiveProject(sender, projectKey);
    await sendReply(
      sender,
      `Project ${formatProjectName(projectKey)} creado y activado.`
    );
    return true;
  }

  const projectKey = args[0].toLowerCase();
  if (!(await projectExists(projectKey))) {
    await sendReply(
      sender,
      `Project ${formatProjectName(projectKey)} no existe. Disponibles: ${available
        .map(formatProjectName)
        .join(", ")}`
    );
    return true;
  }

  await setActiveProject(sender, projectKey);
  const session = await getSession(sender, projectKey);
  const status = session.summary
    ? "contexto previo cargado"
    : "nueva sesión";
  await sendReply(
    sender,
    `Cambiado a Project ${formatProjectName(projectKey)}. ${status}.`
  );
  return true;
}

async function handleResetCommand(sender, args) {
  const projectKey = args[0]?.toLowerCase() || (await getActiveProject(sender));
  await resetSession(sender, projectKey);
  await sendReply(
    sender,
    `Sesión de Project ${formatProjectName(projectKey)} reiniciada.`
  );
  return true;
}

function parseISODate(str) {
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

async function handleRemindCommand(sender, args) {
  if (args.length < 2) {
    await sendReply(
      sender,
      "Uso: /remind <YYYY-MM-DDTHH:mm> <mensaje> [project:<nombre>]"
    );
    return true;
  }

  const triggerAt = parseISODate(args[0]);
  if (!triggerAt) {
    await sendReply(
      sender,
      "Fecha invalida. Usa formato ISO: 2026-07-15T09:00"
    );
    return true;
  }

  let project = "default";
  const projectArgIndex = args.findIndex((a) => a.startsWith("project:"));
  if (projectArgIndex !== -1) {
    project = args[projectArgIndex].slice("project:".length);
    args.splice(projectArgIndex, 1);
  }

  const prompt = args.slice(1).join(" ");
  if (!prompt.trim()) {
    await sendReply(sender, "El mensaje del recordatorio no puede estar vacio.");
    return true;
  }

  const event = await addEvent({
    type: "reminder",
    triggerAt,
    to: sender,
    project,
    prompt,
  });

  await sendReply(
    sender,
    `Recordatorio programado (${event.id.slice(0, 8)}): ${new Date(
      triggerAt
    ).toLocaleString("es-PE", { timeZone: "America/Lima" })} — ${prompt}`
  );
  return true;
}

async function handleEventsCommand(sender) {
  const events = await listEvents();
  if (events.length === 0) {
    await sendReply(sender, "No hay eventos programados.");
    return true;
  }

  const lines = ["Eventos programados:"];
  for (const e of events.slice(0, 20)) {
    const dateStr = new Date(e.triggerAt).toLocaleString("es-PE", {
      timeZone: "America/Lima",
    });
    lines.push(
      `- ${e.id.slice(0, 8)} | ${dateStr} | ${e.type} | ${e.prompt.slice(0, 50)}${
        e.prompt.length > 50 ? "..." : ""
      }`
    );
  }
  if (events.length > 20) {
    lines.push(`... y ${events.length - 20} mas.`);
  }
  await sendReply(sender, lines.join("\n"));
  return true;
}

async function handleEventCancelCommand(sender, args) {
  const id = args[0];
  if (!id) {
    await sendReply(sender, "Uso: /event cancel <id>");
    return true;
  }

  const event = await cancelEvent(id);
  if (!event) {
    await sendReply(sender, `No encontre evento con id ${id}.`);
    return true;
  }

  await sendReply(sender, `Evento cancelado: ${event.prompt.slice(0, 60)}`);
  return true;
}

async function handleArchiveCommand(sender, args) {
  const state = await getConversationState(sender);
  const lastAttachment = state.lastAttachment;
  if (!lastAttachment) {
    await sendReply(sender, "No tengo un archivo reciente para resguardar. Enviame uno primero.");
    return true;
  }

  const category = args[0] || "general";
  try {
    const archivedPath = await archiveAttachment(lastAttachment.path, category);
    await sendReply(
      sender,
      `Archivo resguardado permanentemente:\n${archivedPath}\n\nCategoría: ${category}`
    );
  } catch (err) {
    console.error("Archive command failed:", err);
    await sendReply(sender, `No pude resguardar el archivo: ${err.message}`);
  }
  return true;
}

const SKILL_COMMANDS = [
  "morning",
  "checkin",
  "triage-inbox",
  "capture",
  "decide",
  "post-meeting",
  "weekly-review",
  "index-vault",
];

function skillPrompt(text) {
  const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
  const lowerCmd = cmd.toLowerCase();
  if (!SKILL_COMMANDS.includes(lowerCmd)) return null;
  const skillArgs = args.join(" ");
  return skillArgs ? `/skill:${lowerCmd} ${skillArgs}` : `/skill:${lowerCmd}`;
}

async function handleHandoffCommand(sender, args) {
  const subcmd = args[0]?.toLowerCase();
  if (subcmd === "clear") {
    await clearHandoff();
    await sendReply(sender, "Handoff limpiado.");
    return true;
  }

  const activeProject = await getActiveProject(sender);
  const note = args.join(" ").trim();

  // Ask Kimi to structure the handoff from the recent conversation context.
  const recentMessages = await getRecentMessages(sender, 10);
  const conversationText = recentMessages
    .map((m) => {
      const who = m.incoming ? "Mauricio" : "Kimi";
      const msg = m.incoming || m.outgoing || "";
      return `${who}: ${msg}`;
    })
    .join("\n");

  const prompt = [
    "Eres JARVIS, el EA/CoS de Mauricio. Vas a guardar un handoff de estado para retomar después.",
    "Extrae del siguiente hilo reciente:",
    "- objective: el objetivo actual en una oración",
    "- progress: qué se acordó/decidió/avanzó",
    "- blockers: qué falta o qué bloquea continuar",
    "- next_steps: lista de 1-5 pasos concretos",
    "",
    "Responde SOLO con un JSON válido con esta forma:",
    '{"objective":"...","progress":"...","blockers":"...","next_steps":["...","..."]}',
    "",
    note ? `Nota adicional del usuario: ${note}` : "",
    "Hilo reciente:",
    conversationText.slice(0, 3000),
  ]
    .filter(Boolean)
    .join("\n");

  const response = await askKimi(prompt, {
    projectDir: CONFIG.kimi.projectDir,
    project: activeProject,
  });

  let parsed = { objective: note, progress: "", blockers: "", next_steps: [] };
  try {
    const answer = response.answer || "";
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error("Failed to parse handoff JSON:", err, response.answer);
  }

  await writeHandoff({
    activeProject,
    objective: parsed.objective || note,
    progress: parsed.progress || "",
    blockers: parsed.blockers || "",
    nextSteps: parsed.next_steps || [],
  });

  await sendReply(
    sender,
    [
      "Handoff guardado.",
      `Project: ${formatProjectName(activeProject)}`,
      `Objetivo: ${parsed.objective || note || "(no definido)"}`,
      `Próximos pasos:`,
      ...((parsed.next_steps || []).map((s) => `- ${s}`).slice(0, 5) || ["- (ninguno)"]),
    ].join("\n")
  );
  return true;
}

let pendingUserModelProposal = null;

async function handleApproveUserModelCommand(sender, args) {
  if (!pendingUserModelProposal || pendingUserModelProposal.propose.length === 0) {
    await sendReply(sender, "No hay propuesta de perfil de usuario pendiente.");
    return true;
  }

  const indices = args.length > 0
    ? args.map((a) => parseInt(a, 10) - 1).filter((n) => !isNaN(n) && n >= 0)
    : pendingUserModelProposal.propose.map((_, i) => i);

  const toApply = pendingUserModelProposal.propose.filter((_, i) => indices.includes(i));
  const applied = [];
  for (const update of toApply) {
    try {
      await applyUserModelUpdate(update);
      applied.push(update.fact);
    } catch (err) {
      console.error("Failed to apply user model update:", err);
    }
  }

  pendingUserModelProposal = null;
  await sendReply(
    sender,
    applied.length > 0
      ? `Perfil actualizado con:\n${applied.map((f) => `- ${f}`).join("\n")}`
      : "No se aplicó ninguna actualización."
  );
  return true;
}

async function maybeProposeUserModelUpdate(sender, activeProject) {
  if (!CONFIG.userModel.enabled) return;
  const count = await getOwnerTurnCount(sender);
  if (count < CONFIG.userModel.turnThreshold) return;

  try {
    const proposal = await proposeUserModelUpdate(sender, activeProject);
    if (proposal.skipped) {
      await resetOwnerTurnCount(sender);
      return;
    }

    for (const update of proposal.autoApply) {
      await applyUserModelUpdate(update);
    }

    const message = formatUserModelProposal(proposal);
    if (message) {
      pendingUserModelProposal = proposal;
      await sendReply(sender, message);
    }

    await resetOwnerTurnCount(sender);
  } catch (err) {
    console.error("User model update proposal failed:", err);
  }
}

async function handleCommand({ sender, text }) {
  const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "brief":
      await runMorningBrief(sender);
      return true;
    case "metrics": {
      const domain = args[0] || undefined;
      const metrics = await listMetrics(domain);
      await sendReply(sender, formatMetrics(metrics));
      return true;
    }
    case "status":
      await sendReply(sender, "Kimi runtime activo. MemPalace conectado.");
      return true;
    case "project":
    case "p":
      return await handleProjectCommand(sender, args);
    case "reset":
      return await handleResetCommand(sender, args);
    case "remind":
      return await handleRemindCommand(sender, args);
    case "events":
      return await handleEventsCommand(sender);
    case "event": {
      if (args[0]?.toLowerCase() === "cancel") {
        return await handleEventCancelCommand(sender, args.slice(1));
      }
      await sendReply(sender, "Uso: /event cancel <id>");
      return true;
    }
    case "archive":
      return await handleArchiveCommand(sender, args);
    case "handoff":
      return await handleHandoffCommand(sender, args);
    case "policies": {
      const policies = await listPolicies();
      await sendReply(sender, formatPoliciesList(policies));
      return true;
    }
    case "policy": {
      const subcmd = args[0]?.toLowerCase();
      if (subcmd === "apply") {
        return await handlePolicyApplyCommand(sender, args[1]);
      }
      if (subcmd === "cancel") {
        return await handlePolicyCancelCommand(sender, args[1]);
      }
      if (subcmd === "show") {
        const name = args[1];
        if (!name) {
          await sendReply(sender, "Uso: /policy show <nombre>");
          return true;
        }
        const policy = await getPolicy(name);
        if (!policy.exists) {
          await sendReply(sender, `No encontré la policy ${name}. Policies activas: ${(await listPolicies()).join(", ")}`);
          return true;
        }
        await sendReply(sender, policy.content.slice(0, 1500));
        return true;
      }
      if (subcmd === "revert") {
        const name = args[1];
        if (!name) {
          await sendReply(sender, "Uso: /policy revert <nombre>");
          return true;
        }
        try {
          const result = await revertPolicy(name);
          await sendReply(sender, `Policy ${result.name} revertida desde:\n${result.restoredFrom}`);
        } catch (err) {
          await sendReply(sender, `No pude revertir la policy: ${err.message}`);
        }
        return true;
      }
      await sendReply(sender, "Uso: /policy show|apply|cancel|revert ...");
      return true;
    }
    case "approve":
      return await handleApprovalCommand(sender, args[0], true);
    case "deny":
      return await handleApprovalCommand(sender, args[0], false);
    case "approve-user-model":
      return await handleApproveUserModelCommand(sender, args);
    default:
      return false;
  }
}

function formatApprovalMessage(approval) {
  const lines = [
    `JARVIS pide aprobación #${approval.id}`,
    "",
    "Acciones propuestas:",
    ...approval.toolCalls.map((tc, i) => {
      const display = formatToolForDisplay(tc.name, tc.arguments);
      return `${i + 1}. ${display}`;
    }),
    "",
    `Riesgo: requiere aprobación`,
    `Motivo: ${approval.toolCalls.map((tc) => tc.reason).join("; ")}`,
    `Expira en: 1 hora`,
    "",
    "Responde:",
    `/approve ${approval.id}`,
    `/deny ${approval.id}`,
  ];
  return lines.join("\n");
}

async function handleApprovalCommand(sender, approvalId, approved) {
  if (!approvalId) {
    await sendReply(sender, "Uso: /approve <id> o /deny <id>");
    return true;
  }

  const approval = approved
    ? await approveApproval(approvalId, sender)
    : await denyApproval(approvalId, sender);

  if (!approval) {
    await sendReply(
      sender,
      `No encontré la solicitud ${approvalId}. Puede haber expirado (1h) o ya fue respondida.`
    );
    return true;
  }

  if (!approved) {
    const deniedDesc = approval.toolCalls
      .map((tc) => formatToolForDisplay(tc.name, tc.arguments))
      .join("\n");
    const denyPrompt =
      `El usuario denegó las siguientes acciones:\n${deniedDesc}\n\n` +
      `Respondé brevemente reconociendo la denegación.`;
    const denyResponse = await askKimi(denyPrompt, approval.context);
    const denyReply = denyResponse.answer || "Acción denegada por el usuario.";
    await sendReply(sender, denyReply);
    await removeApproval(approvalId);

    // Audit log: approval denied.
    logTurn({
      chatJid: approval.chat,
      authorJid: sender,
      project: approval.project,
      incoming: `/deny ${approvalId}`,
      outgoing: denyReply,
      prompt: denyResponse.prompt || denyPrompt,
      kimiResponse: {
        answer: denyReply,
        toolCalls: [],
        error: denyResponse.error || null,
      },
      attachment: null,
      durationMs: null,
    }).catch((err) => {
      console.error("Audit logging failed (approval deny):", err);
    });

    return true;
  }

  // Execute approved tools.
  const approvalStart = Date.now();
  const results = [];
  for (const tc of approval.toolCalls) {
    const execResult = await executeTool(tc.name, tc.arguments, {
      chat: approval.chat,
      project: approval.project,
      decision: "ask",
      approvedBy: sender,
    });
    results.push({
      name: tc.name,
      args: tc.arguments,
      success: execResult.success,
      output: execResult.output,
      error: execResult.error,
    });
  }

  const resultPrompt = buildToolResultPrompt(
    approval.context?.originalPrompt || "(mensaje previo)",
    results
  );
  const response = await askKimi(resultPrompt, approval.context);
  const reply = response.error
    ? `Error consultando a Kimi: ${response.error}`
    : (response.answer || "Listo.");
  await sendReply(sender, reply);
  await recordOutgoing(approval.chat, reply, approval.project);
  await removeApproval(approvalId);

  // Audit log: approval executed.
  logTurn({
    chatJid: approval.chat,
    authorJid: sender,
    project: approval.project,
    incoming: `/approve ${approvalId}`,
    outgoing: reply,
    prompt: response.prompt || resultPrompt,
    kimiResponse: {
      answer: reply,
      toolCalls: approval.toolCalls,
      error: response.error || null,
    },
    attachment: null,
    durationMs: Date.now() - approvalStart,
  }).catch((err) => {
    console.error("Audit logging failed (approval execution):", err);
  });

  // Log the resumed turn.
  await logConversation({
    timestamp: new Date().toISOString(),
    sender: approval.chat,
    author: sender,
    project: approval.project,
    isOwner: true,
    isGroup: approval.chat?.endsWith("@g.us") || false,
    incoming: `/approve ${approvalId}`,
    outgoing: reply,
    memPalaceResultCount: 0,
  });

  return true;
}

async function approvalCleanupLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, 60000));
    try {
      const expired = await listExpired();
      for (const a of expired) {
        try {
          await sendReply(
            a.chat,
            `⏰ La solicitud #${a.id} expiró sin respuesta (1h).`
          );
        } catch (err) {
          console.error("Failed to notify expired approval:", err);
        }
      }
      await cleanupExpired();
    } catch (err) {
      console.error("Approval cleanup error:", err);
    }
  }
}

// --- Policy update system ---

const pendingPolicyUpdates = new Map();
let policyUpdateIdCounter = 1;

const POLICY_UPDATE_INTENT_PATTERNS = [
  /^\s*nueva regla\s*[,:]?\s+(?:de|para|sobre)\s+/i,
  /^\s*actualiz[áa]\s+(?:la\s+)?(?:regla|policy|pol[íi]tica)\s*[,:]?\s+(?:de|para|sobre)\s+/i,
  /^\s*cambi[áa]\s+(?:la\s+)?(?:regla|policy|pol[íi]tica)\s*[,:]?\s+(?:de|para|sobre)\s+/i,
  /^\s*modific[áa]\s+(?:la\s+)?(?:regla|policy|pol[íi]tica)\s*[,:]?\s+(?:de|para|sobre)\s+/i,
  /^\s*desde ahora\s*[,:]?\s+/i,
  /^\s*de ahora en adelante\s*[,:]?\s+/i,
];

const POLICY_AREA_KEYWORDS = {
  calendar: ["calendario", "calendar", "evento", "agenda"],
  email: ["email", "mail", "correo", "gmail", "inbox"],
  wealth: ["wealth", "dinero", "plata", "gasto", "ingreso", "inversión", "inversion", "deuda", "tarjeta", "banco"],
  health: ["health", "salud", "peso", "sueño", "ejercicio", "gym", "médico", "medico"],
  meetings: ["meetings", "reunión", "reunion", "reuniones", "granola", "transcripción", "transcripcion"],
  proactive: ["proactive", "proactivo", "alerta", "notificación", "notificacion", "trigger"],
  "communication-style": ["estilo", "tono", "formato", "comunicación", "comunicacion", "respuesta"],
  permissions: ["permisos", "permissions", "aprobación", "aprobacion", "permitir", "denegar"],
};

export function detectPolicyUpdateIntent(text) {
  return POLICY_UPDATE_INTENT_PATTERNS.some((re) => re.test(text));
}

export function detectPolicyArea(text) {
  const lower = text.toLowerCase();
  for (const [area, keywords] of Object.entries(POLICY_AREA_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) {
      return area;
    }
  }
  return null;
}

function generatePolicyUpdateId() {
  const id = `p${policyUpdateIdCounter.toString(36)}`;
  policyUpdateIdCounter += 1;
  return id;
}

async function proposePolicyUpdate(sender, text, context) {
  const area = detectPolicyArea(text);
  if (!area) {
    await sendReply(
      sender,
      "Detecté que querés agregar una regla, pero no identifiqué el área (calendario, email, wealth, health, meetings, proactive, communication-style, permissions). ¿Podés reformularlo?"
    );
    return true;
  }

  const existing = await getPolicy(area);
  const ruleText = text.replace(/^\s*(?:nueva regla|actualiz[áa]|cambi[áa]|modific[áa]|desde ahora|de ahora en adelante)\s+(?:de|para|sobre|la|el)?\s*/i, "").trim();

  const newContent = existing.exists
    ? existing.content.trim() + `\n\n## Nueva regla\n\n${ruleText}\n`
    : `# Policy: ${area}\n\n${ruleText}\n`;

  const id = generatePolicyUpdateId();
  pendingPolicyUpdates.set(id, {
    id,
    chat: sender,
    area,
    previousContent: existing.exists ? existing.content : "",
    newContent,
    ruleText,
    createdAt: Date.now(),
  });

  const lines = [
    `Propuesta de actualización de policy #${id}`,
    `Área: ${area}`,
    "",
    "Regla propuesta:",
    `- ${ruleText}`,
    "",
    existing.exists ? "Se agregará al final de la policy existente." : "Se creará una nueva policy.",
    "",
    "Responde:",
    `/policy apply ${id}`,
    `/policy cancel ${id}`,
  ];
  await sendReply(sender, lines.join("\n"));
  return true;
}

async function handlePolicyApplyCommand(sender, id) {
  const update = pendingPolicyUpdates.get(id);
  if (!update) {
    await sendReply(sender, `No encontré la propuesta ${id}. Puede haber expirado (1h) o ya fue respondida.`);
    return true;
  }

  try {
    const result = await updatePolicy(update.area, update.newContent, `Updated via WhatsApp: ${update.ruleText.slice(0, 100)}`);
    pendingPolicyUpdates.delete(id);
    await sendReply(sender, `Policy ${result.name} actualizada. Backup guardado automáticamente.`);
  } catch (err) {
    console.error("Policy apply failed:", err);
    await sendReply(sender, `No pude aplicar la policy: ${err.message}`);
  }
  return true;
}

async function handlePolicyCancelCommand(sender, id) {
  const existed = pendingPolicyUpdates.delete(id);
  await sendReply(
    sender,
    existed ? `Propuesta ${id} cancelada.` : `No encontré la propuesta ${id}.`
  );
  return true;
}

async function policyCleanupLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, 60000));
    try {
      const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
      for (const [id, update] of pendingPolicyUpdates.entries()) {
        if (update.createdAt < cutoff) {
          pendingPolicyUpdates.delete(id);
          try {
            await sendReply(update.chat, `⏰ La propuesta de policy #${id} expiró sin respuesta.`);
          } catch (err) {
            console.error("Failed to notify expired policy update:", err);
          }
        }
      }
    } catch (err) {
      console.error("Policy cleanup error:", err);
    }
  }
}

const MAX_THREAD_MESSAGES_IN_PROMPT = 10;
const MAX_MESSAGE_LENGTH_IN_THREAD = 500;

function formatRecentMessages(messages, limit = MAX_THREAD_MESSAGES_IN_PROMPT) {
  if (!messages || messages.length === 0) return "";
  const recent = messages.slice(-limit);
  const lines = recent.map((m) => {
    const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 16) : "";
    const who = m.author && CONFIG.whatsapp.ownerNumbers.includes(m.author) ? "Mauricio" : "Kimi";
    const incoming = (m.incoming || "").slice(0, MAX_MESSAGE_LENGTH_IN_THREAD);
    const outgoing = (m.outgoing || "").slice(0, MAX_MESSAGE_LENGTH_IN_THREAD);
    const parts = [];
    if (incoming) parts.push(`[${ts}] ${who}: ${incoming}`);
    if (outgoing) parts.push(`[${ts}] Kimi: ${outgoing}`);
    return parts.join("\n");
  });
  return lines.join("\n");
}

function extractKeywords(text, conversationState) {
  const words = (text || "")
    .toLowerCase()
    .replace(/[^\w\sáéíóúñ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const unique = Array.from(new Set(words)).slice(0, 8);
  const topic = (conversationState.currentTopic || "").toLowerCase();
  if (topic && !unique.includes(topic)) unique.unshift(topic);
  return unique.join(" ");
}

async function searchContextProactively(text, conversationState) {
  const keywords = extractKeywords(text, conversationState);
  let memPalaceResults = [];
  try {
    const palace = await searchMemPalace(keywords, 3);
    memPalaceResults = palace.results || [];
  } catch (err) {
    console.error("Proactive MemPalace search failed:", err);
  }
  return { memPalaceResults };
}

const FOLLOW_UP_PATTERNS = [
  /\b(eso|eso mismo|ahora|también|igual|dale|ok|perfecto|listo)\b/i,
  /\b(el|la|los|las)\s+(bcp|estado de cuenta|reunión|email|correo|tarjeta|banco|cuenta|pdf|adjunto)\b/i,
  /\bmi dni es\b/i,
  /\bmi número de cuenta\b/i,
];

function detectImplicitFollowUp(text, conversationState, recentMessages) {
  if (!conversationState.pendingAction) return false;
  const lower = (text || "").toLowerCase();
  const wordCount = text.trim().split(/\s+/).length;
  const isShort = wordCount < 20;
  const hasPattern = FOLLOW_UP_PATTERNS.some((re) => re.test(lower));
  const lastMessage = recentMessages[recentMessages.length - 1];
  const lastWasKimi = lastMessage && !lastMessage.incoming;
  return (isShort || hasPattern) && lastWasKimi;
}

function expandPromptWithContext(text, conversationState) {
  if (!conversationState.pendingAction) return text;
  const lower = text.toLowerCase();
  const isSharingSensitive =
    /\b(dni|número de cuenta|cuenta bancaria|tarjeta|clave|password|pass)\b/i.test(lower);
  if (isSharingSensitive) {
    return (
      `${text}\n\n` +
      `[Contexto interno: esto responde a una acción pendiente: "${conversationState.pendingAction}". ` +
      `Usá el dato compartido para ejecutar esa acción directamente, sin preguntar cómo ni repetir lo que ya sabés.]`
    );
  }
  if (detectImplicitFollowUp(text, conversationState, [])) {
    return (
      `${text}\n\n` +
      `[Contexto interno: esto parece una continuación de: "${conversationState.pendingAction}". ` +
      `Si es posible, continuá esa acción directamente.]`
    );
  }
  return text;
}

function looksLikeCompletion(reply, pendingAction) {
  if (!pendingAction || !reply) return false;
  const lower = reply.toLowerCase();
  return (
    lower.includes("listo") ||
    lower.includes("hecho") ||
    lower.includes("registrado") ||
    lower.includes("guardado") ||
    lower.includes("revisado") ||
    lower.includes("enviado") ||
    lower.includes("completado")
  );
}

function inferConversationState(text, reply, prevState) {
  const lowerText = (text || "").toLowerCase();
  const lowerReply = (reply || "").toLowerCase();
  const nextState = {
    currentTopic: prevState.currentTopic,
    pendingAction: prevState.pendingAction,
    sharedFacts: { ...prevState.sharedFacts },
    lastIntent: prevState.lastIntent,
  };

  // Detect shared facts.
  const dniMatch = text.match(/\b\d{8,12}\b/);
  if (dniMatch && lowerText.includes("dni")) {
    nextState.sharedFacts.dni = dniMatch[0];
    nextState.currentTopic = "datos personales";
  }

  // Detect pending action patterns.
  if (/\brevis\w*\s+(el\s+)?estado de cuenta\b/i.test(text)) {
    nextState.pendingAction = "revisar estado de cuenta";
    const bankMatch = text.match(/\b(BCP|Interbank|BBVA|Scotiabank|Banbif|MiBanco)\b/i);
    if (bankMatch) {
      nextState.sharedFacts.banco = bankMatch[0];
      nextState.currentTopic = `estado de cuenta ${bankMatch[0]}`;
    }
  }

  // Update topic based on explicit topic words.
  if (/\bestado de cuenta\b/i.test(text)) nextState.currentTopic = "estado de cuenta";
  if (/\bpeso\b/i.test(text)) nextState.currentTopic = "peso";
  if (/\bgasto\b/i.test(text)) nextState.currentTopic = "gasto";
  if (/\breunión\b/i.test(text)) nextState.currentTopic = "reunión";

  // Clear pending action if reply looks like completion.
  if (looksLikeCompletion(reply, prevState.pendingAction)) {
    nextState.pendingAction = "";
  }

  // If user asks a new clear task, set it as pending.
  if (/\b(revisá|buscá|encontrá|mandá|enviá|pagá|registrá|recordá|recordame|avísame)\b/i.test(text)) {
    nextState.pendingAction = text.slice(0, 120);
  }

  return nextState;
}

function inferStateFromOutgoing(outgoing, prevState) {
  const lower = (outgoing || "").toLowerCase();
  const nextState = {
    currentTopic: prevState.currentTopic,
    pendingAction: prevState.pendingAction,
    sharedFacts: { ...prevState.sharedFacts },
    lastIntent: prevState.lastIntent,
  };

  const bankMatch = (outgoing || "").match(/\b(BCP|Interbank|BBVA|Scotiabank|Banbif|MiBanco)\b/i);
  if (bankMatch && /\bestado de cuenta\b/i.test(outgoing)) {
    nextState.sharedFacts.banco = bankMatch[0];
    nextState.currentTopic = `estado de cuenta ${bankMatch[0]}`;
    nextState.pendingAction = `revisar estado de cuenta ${bankMatch[0]}`;
  } else if (bankMatch && /\bpago de tarjeta\b/i.test(outgoing)) {
    nextState.sharedFacts.banco = bankMatch[0];
    nextState.currentTopic = `pago tarjeta ${bankMatch[0]}`;
    nextState.pendingAction = `revisar pago de tarjeta ${bankMatch[0]}`;
  }

  if (/\breunión\b/i.test(outgoing) && /\bpróximos pasos\b/i.test(outgoing)) {
    nextState.currentTopic = "reunión";
    nextState.pendingAction = "seguir próximos pasos de reunión";
  }

  return nextState;
}

async function recordOutgoing(to, text, projectKey) {
  const project = projectKey || (await getActiveProject(to));
  await addRecentMessage(to, {
    author: null,
    incoming: null,
    outgoing: text,
    project,
  });
  appendTurn({
    chatJid: to,
    project,
    role: "assistant",
    content: text,
    authorJid: null,
    timestamp: new Date().toISOString(),
  });
  const state = await getConversationState(to);
  const nextState = inferStateFromOutgoing(text, state);
  await updateConversationState(to, nextState);
}

async function processAttachment(attachment) {
  if (!attachment) return attachment;

  // Speech-to-text for audio and voice notes.
  if (attachment.type === "audio" || attachment.type === "ptt") {
    try {
      console.log(`Transcribing audio: ${attachment.path}`);
      const result = await transcribeAudio(attachment.path, { language: "es" });
      attachment.transcription = result.text;
      console.log(`Transcription (${result.model}): ${result.text.slice(0, 100)}...`);
    } catch (err) {
      console.error("Audio transcription failed:", err.message);
      attachment.transcriptionError = err.message;
    }
    return attachment;
  }

  // Extract archives.
  if (isArchive(attachment.mimetype, attachment.originalName || attachment.filename)) {
    try {
      console.log(`Extracting archive: ${attachment.path}`);
      const result = await extractArchive(attachment.path, attachment.mimetype, DOWNLOADS_DIR);
      attachment.extracted = {
        path: result.extractedPath,
        type: result.type,
        fileCount: result.files.filter((f) => f.type === "file").length,
        files: result.files.slice(0, 100), // Limit to avoid huge prompts.
      };
      console.log(`Archive extracted to ${result.extractedPath} (${result.files.length} entries)`);
    } catch (err) {
      console.error("Archive extraction failed:", err.message);
      attachment.extractionError = err.message;
    }
    return attachment;
  }

  return attachment;
}

async function handleMessage({ sender, author, text, isOwner, isGroup, msg, attachment }) {
  const timestamp = new Date().toISOString();

  const activeProject = await getActiveProject(sender);
  const projectDir = resolveProjectDir(activeProject);

  if (text.startsWith("/") && isOwner) {
    const handled = await handleCommand({ sender, text });
    if (handled) return;
    // If it's a known skill command, rewrite the prompt and let Kimi handle it.
    const skill = skillPrompt(text);
    if (skill) {
      text = skill;
    }
  }

  // Detect policy update intent for owner messages.
  if (isOwner && detectPolicyUpdateIntent(text)) {
    const handled = await proposePolicyUpdate(sender, text, {
      projectDir,
      project: activeProject,
      sender: author,
      isOwner,
      isGroup,
    });
    if (handled) return;
  }

  // Show typing indicator while Kimi is thinking.
  let typingInterval = null;
  try {
    await sock.sendPresenceUpdate("composing", sender);
    typingInterval = setInterval(async () => {
      try {
        await sock.sendPresenceUpdate("composing", sender);
      } catch (err) {
        // Non-fatal.
      }
    }, 20000);
  } catch (err) {
    // Non-fatal: typing indicator may fail in some chat types.
  }

  const conversationState = await getConversationState(sender);

  // Transcribe audio or extract archives before building the prompt.
  if (attachment) {
    attachment = await processAttachment(attachment);
  }

  // Persist incoming user turn in LCM.
  appendTurn({
    chatJid: sender,
    project: activeProject,
    role: "user",
    content: attachment ? `[archivo adjunto: ${attachment.filename}]${text ? " " + text : ""}` : text,
    authorJid: author,
    timestamp,
  });

  const lcmContext = buildLcmContext(sender, activeProject);

  const session = await getSession(sender, activeProject);
  const summary = await getSummary(sender, activeProject);
  const recentMessages = await getRecentMessages(sender, MAX_THREAD_MESSAGES_IN_PROMPT);

  // Proactive context retrieval.
  const proactiveContext = await searchContextProactively(text, conversationState);
  const proactiveMemPalaceResults = proactiveContext.memPalaceResults || [];

  // Expand prompt if this looks like a follow-up or data-sharing turn.
  let expandedPrompt = expandPromptWithContext(text, conversationState);
  if (!expandedPrompt.trim() && attachment) {
    expandedPrompt = "[Recibí un archivo adjunto por WhatsApp]";
  }

  const palace = await searchMemPalace(text, 3);
  const availableProjects = await listProjects();
  const handoff = await readHandoff();
  const memoryContext = await fetchMemoryContext(text, activeProject);
  const context = {
    projectDir,
    project: activeProject,
    availableProjects,
    summary,
    lcmContext,
    sender: author,
    chat: sender,
    isOwner,
    isGroup,
    memPalaceResults: palace.results || [],
    proactiveMemPalaceResults,
    recentMessages,
    conversationState,
    originalPrompt: text,
    attachment,
    handoff,
    memoryContext,
  };

  let reply = null;
  const MAX_TOOL_CYCLES = 3;
  let currentPrompt = expandedPrompt;
  let initialPrompt = null;
  const allToolCalls = [];
  const turnStart = Date.now();

  for (let cycle = 0; cycle < MAX_TOOL_CYCLES; cycle++) {
    const kimiResponse = await askKimi(currentPrompt, context);
    if (initialPrompt === null) {
      initialPrompt = kimiResponse.prompt || "";
    }
    if (kimiResponse.toolCalls) {
      allToolCalls.push(...kimiResponse.toolCalls);
    }

    if (!kimiResponse.toolCalls || kimiResponse.toolCalls.length === 0) {
      reply = kimiResponse.error
        ? `Error consultando a Kimi: ${kimiResponse.error}`
        : kimiResponse.answer;
      break;
    }

    // Kimi returned tool_calls. In most cases Kimi already executed the tool
    // internally and included the result in the answer. If there is an answer,
    // we trust it and only audit the tools instead of re-executing them.
    const hasAnswer = !!(kimiResponse.answer || "").trim();
    if (hasAnswer) {
      const evaluations = [];
      for (const tc of kimiResponse.toolCalls) {
        const decision = await evaluateTool(tc.name, tc.arguments);
        evaluations.push({ ...tc, decision: decision.decision, reason: decision.reason });
      }

      const denied = evaluations.filter((e) => e.decision === "deny");
      if (denied.length === 0) {
        reply = kimiResponse.answer;
        break;
      }

      // Some tools were denied. Ask Kimi to re-answer without using them.
      const deniedDesc = denied
        .map((e) => `- ${formatToolForDisplay(e.name, e.arguments)} (${e.reason})`)
        .join("\n");
      const denyPrompt =
        `Las siguientes herramientas que usaste no están permitidas por política de seguridad:\n${deniedDesc}\n\n` +
        `Respondé al mensaje original del usuario SIN usar esas herramientas. ` +
        `Si necesitás crear o modificar archivos, usá write/edit. ` +
        `Si necesitás explorar el filesystem, usá read/glob/grep. ` +
        `No uses bash para listar directorios ni para escribir archivos.\n\n` +
        `Mensaje original del usuario:\n${text}`;
      const retryResponse = await askKimi(denyPrompt, context);
      const retryEvaluations = [];
      for (const tc of retryResponse.toolCalls || []) {
        const decision = await evaluateTool(tc.name, tc.arguments);
        retryEvaluations.push({ ...tc, decision: decision.decision, reason: decision.reason });
      }
      const stillDenied = retryEvaluations.filter((e) => e.decision === "deny");
      if (stillDenied.length === 0) {
        reply = retryResponse.answer || "Listo.";
      } else {
        const stillDeniedDesc = stillDenied
          .map((e) => `- ${formatToolForDisplay(e.name, e.arguments)} (${e.reason})`)
          .join("\n");
        reply = `⚠️ No pude completar la acción porque las siguientes herramientas están denegadas por política de seguridad:\n${stillDeniedDesc}`;
      }
      break;
    }

    // No answer: Kimi is asking the runtime to execute the tools.
    const evaluations = [];
    for (const tc of kimiResponse.toolCalls) {
      const decision = await evaluateTool(tc.name, tc.arguments);
      evaluations.push({ ...tc, decision: decision.decision, reason: decision.reason });
    }

    // Denied tools: short-circuit with an explanation.
    const denied = evaluations.filter((e) => e.decision === "deny");
    if (denied.length > 0) {
      const deniedDesc = denied
        .map((e) => `- ${formatToolForDisplay(e.name, e.arguments)} (${e.reason})`)
        .join("\n");
      const denyPrompt =
        `Las siguientes acciones solicitadas fueron denegadas por política de seguridad:\n${deniedDesc}\n\n` +
        `Respondé al usuario explicando brevemente por qué no se pudieron ejecutar y qué alternativas tiene.`;
      const denyResponse = await askKimi(denyPrompt, context);
      reply = denyResponse.answer || "Algunas acciones fueron denegadas por política de seguridad.";
      break;
    }

    // Tools requiring approval: pause the turn and ask the user.
    const askOnes = evaluations.filter((e) => e.decision === "ask");
    if (askOnes.length > 0) {
      const approval = await createApproval({
        chat: sender,
        project: activeProject,
        toolCalls: askOnes,
        context,
      });
      const approvalMessage = formatApprovalMessage(approval);
      await sendReply(sender, approvalMessage);

      // Audit log: approval requested.
      logTurn({
        chatJid: sender,
        authorJid: author,
        project: activeProject,
        incoming: text,
        outgoing: approvalMessage,
        prompt: initialPrompt,
        kimiResponse: {
          answer: approvalMessage,
          toolCalls: askOnes,
          error: null,
        },
        attachment,
        durationMs: Date.now() - turnStart,
      }).catch((err) => {
        console.error("Audit logging failed (approval request):", err);
      });

      // Pause here; approval command will resume the turn.
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      return;
    }

    // Auto and notify tools: execute now.
    const execOnes = evaluations.filter(
      (e) => e.decision === "auto" || e.decision === "notify"
    );
    const results = [];
    for (const e of execOnes) {
      const execResult = await executeTool(e.name, e.arguments, {
        chat: sender,
        project: activeProject,
        decision: e.decision,
      });
      results.push({
        name: e.name,
        args: e.arguments,
        success: execResult.success,
        output: execResult.output,
        error: execResult.error,
      });
      if (e.decision === "notify") {
        const note = `✓ Tool ${e.name} ejecutada:\n${execResult.output.slice(0, 500)}`;
        await sendReply(sender, note);
      }
    }

    if (results.length === 0) {
      reply = "No se pudieron ejecutar las acciones solicitadas.";
      break;
    }

    currentPrompt = buildToolResultPrompt(text, results);
  }

  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }

  if (reply === null) {
    reply = "No pude completar la acción después de varios intentos.";
  }

  await bumpMessageCount(sender, activeProject);
  await sendReply(sender, reply);

  if (isOwner) {
    await bumpOwnerTurnCount(sender);
    await maybeProposeUserModelUpdate(sender, activeProject);
  }

  // Persist assistant turn in LCM.
  appendTurn({
    chatJid: sender,
    project: activeProject,
    role: "assistant",
    content: reply,
    authorJid: null,
    timestamp: new Date().toISOString(),
  });

  try {
    await sock.sendPresenceUpdate("available", sender);
  } catch (err) {
    // Non-fatal.
  }

  // Persist thread context and inferred state.
  await addRecentMessage(sender, {
    author,
    incoming: attachment ? `[archivo adjunto: ${attachment.filename}]${text ? " " + text : ""}` : text,
    outgoing: reply,
    project: activeProject,
  });
  const nextState = inferConversationState(text, reply, conversationState);
  if (attachment) {
    nextState.lastAttachment = {
      path: attachment.path,
      originalName: attachment.originalName || attachment.filename,
      mimetype: attachment.mimetype,
      size: attachment.size,
    };
  }
  await updateConversationState(sender, nextState);

  // Persist turn to MemPalace (conversation drawer + agent diary entry).
  checkpointTurn({
    chatJid: sender,
    project: activeProject,
    incoming: attachment
      ? `[archivo adjunto: ${attachment.filename}]${text ? " " + text : ""}`
      : text,
    outgoing: reply,
    timestamp,
  }).catch((err) => {
    console.error("Checkpoint turn failed:", err);
  });

  await logConversation({
    timestamp,
    sender,
    author,
    project: activeProject,
    isOwner,
    isGroup,
    incoming: text,
    outgoing: reply,
    memPalaceResultCount: (palace.results || []).length,
  });

  // Audit log: prompt, response, tools, errors.
  logTurn({
    chatJid: sender,
    authorJid: author,
    project: activeProject,
    incoming: text,
    outgoing: reply,
    prompt: initialPrompt,
    kimiResponse: {
      answer: reply,
      toolCalls: allToolCalls,
      error: reply && reply.startsWith("Error consultando a Kimi") ? reply : null,
    },
    attachment,
    durationMs: Date.now() - turnStart,
  }).catch((err) => {
    console.error("Audit logging failed:", err);
  });

  // Run LCM compaction in the background.
  maintainLcm(sender, activeProject).catch((err) => {
    console.error("LCM maintenance failed:", err);
  });
}

const ARCHIVE_DIR = "/home/ubuntu/projects/jarvis/vault/archive/whatsapp";
const TEMPORAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function cleanupDownloads() {
  try {
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const entries = await readdir(DOWNLOADS_DIR);
    const cutoff = Date.now() - TEMPORAL_RETENTION_MS;
    let removed = 0;
    for (const entry of entries) {
      const filePath = path.join(DOWNLOADS_DIR, entry);
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await unlink(filePath);
          removed += 1;
        }
      } catch (err) {
        console.error(`Failed to clean up ${filePath}:`, err.message);
      }
    }
    if (removed > 0) {
      console.log(`Cleaned up ${removed} old attachment(s) from ${DOWNLOADS_DIR}`);
    }
  } catch (err) {
    console.error("Attachment cleanup error:", err.message);
  }
}

async function archiveAttachment(sourcePath, category = "general") {
  const safeCategory = category.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const targetDir = path.join(ARCHIVE_DIR, safeCategory);
  await mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, path.basename(sourcePath));
  const { copyFile } = await import("fs/promises");
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

async function cleanupLoop() {
  // Run once at startup, then every hour.
  await cleanupDownloads();
  while (true) {
    await new Promise((r) => setTimeout(r, 60 * 60 * 1000));
    await cleanupDownloads();
  }
}

async function proactiveLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, 60000));

    if (CONFIG.whatsapp.ownerNumbers.length === 0) continue;

    const now = getLimaDate();
    const todayStr = now.toDateString();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const homeGroup = CONFIG.whatsapp.homeGroup;

    // Morning brief once per day.
    const { morningBriefHour, morningBriefMinute } = CONFIG.proactive;
    if (
      currentHour === morningBriefHour &&
      currentMinute === morningBriefMinute &&
      lastMorningBriefDate !== todayStr
    ) {
      if (homeGroup) {
        try {
          await runMorningBrief(homeGroup);
        } catch (err) {
          console.error("Morning brief failed for group", homeGroup, err);
        }
      }
      lastMorningBriefDate = todayStr;
    }

    // Inbox check every 2 hours, Mon-Fri, 08:00-20:00 Lima.
    // Skip if the owner was active in the home group recently (avoid interrupting).
    const limaDayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const isWeekday = limaDayOfWeek >= 1 && limaDayOfWeek <= 5;
    const isCheckWindow = currentHour >= 8 && currentHour <= 20;
    const isEvenHour = currentHour % 2 === 0;
    const lastCheckExpired =
      !lastInboxCheckAt ||
      lastInboxCheckAt.date !== todayStr ||
      lastInboxCheckAt.hour !== currentHour;

    if (isWeekday && isCheckWindow && isEvenHour && lastCheckExpired) {
      const recentActivity = await hasRecentOwnerActivity(20);
      if (homeGroup && !recentActivity) {
        try {
          await runInboxCheck(homeGroup);
        } catch (err) {
          console.error("Inbox check failed for group", homeGroup, err);
        }
      } else if (recentActivity) {
        console.log("Inbox check skipped: recent owner activity in home group.");
      }
      lastInboxCheckAt = { date: todayStr, hour: currentHour };
    }

    // Follow-up check once per day at 09:00.
    if (currentHour === 9 && currentMinute === 0 && lastFollowUpCheckDate !== todayStr) {
      if (homeGroup) {
        try {
          await runFollowUpCheck(homeGroup);
        } catch (err) {
          console.error("Follow-up check failed for group", homeGroup, err);
        }
      }
      lastFollowUpCheckDate = todayStr;
    }

    // Daily log at configured time (default 23:30).
    if (
      CONFIG.dailyLog.enabled &&
      currentHour === CONFIG.dailyLog.hour &&
      currentMinute === CONFIG.dailyLog.minute &&
      lastDailyLogDate !== todayStr
    ) {
      try {
        const log = await generateDailyLog();
        if (homeGroup) {
          const msg = `Daily log generado: ${log.events} eventos, ${log.emails} correos, ${log.tasks} tareas.\nArchivo: ${log.filePath}`;
          await sendReply(homeGroup, msg);
          await recordOutgoing(homeGroup, msg, "default");
        }
      } catch (err) {
        console.error("Daily log generation failed:", err);
      }
      lastDailyLogDate = todayStr;
    }
  }
}

const ALERTS_FILE = "/home/ubuntu/projects/server/logs/alerts-pending.json";
const ALERTS_SENT_FILE = "/home/ubuntu/projects/jarvis/data/alerts-sent.json";
const ALERTS_TZ = "America/Lima";

function getLimaDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ALERTS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function loadSentAlerts() {
  try {
    const raw = await readFile(ALERTS_SENT_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to load sent alerts log:", err);
    return [];
  }
}

async function saveSentAlerts(sent) {
  await mkdir(path.dirname(ALERTS_SENT_FILE), { recursive: true });
  await writeFile(ALERTS_SENT_FILE, JSON.stringify(sent, null, 2));
}

function normalizeAlert(alert) {
  const prompt =
    typeof alert === "string"
      ? alert
      : alert.prompt || alert.message || JSON.stringify(alert);
  return prompt?.trim() || "";
}

async function alertPoller() {
  while (true) {
    await new Promise((r) => setTimeout(r, 60000));

    if (!sock || CONFIG.whatsapp.ownerNumbers.length === 0) continue;

    try {
      const data = await readFile(ALERTS_FILE, "utf8");
      const batches = JSON.parse(data);
      if (!Array.isArray(batches) || batches.length === 0) continue;

      const today = getLimaDateString();
      const sentAlerts = await loadSentAlerts();
      const sentToday = new Set(
        sentAlerts.filter((entry) => entry.date === today).map((entry) => entry.alert)
      );

      // Collect unique new alerts for today across all pending batches.
      const newAlerts = [];
      const seen = new Set();
      for (const batch of batches) {
        for (const alert of batch.alerts || []) {
          const normalized = normalizeAlert(alert);
          if (!normalized) continue;
          if (sentToday.has(normalized)) continue;
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          newAlerts.push(normalized);
        }
      }

      if (newAlerts.length === 0) {
        await unlink(ALERTS_FILE);
        continue;
      }

      const homeGroup = CONFIG.whatsapp.homeGroup;
      if (!homeGroup) {
        console.warn("No home group configured; skipping alert dispatch.");
        continue;
      }

      // Build a single consolidated prompt for all new alerts.
      const alertsText = newAlerts
        .map((a, i) => `${i + 1}. ${a}`)
        .join("\n");

      const response = await askKimi(
        `Eres el asistente ejecutivo personal de Mauricio dentro del proyecto JARVIS. ` +
          `Se generaron las siguientes alertas de infraestructura/monitoreo. ` +
          `Escribe UN SOLO mensaje breve, directo y útil para enviar por WhatsApp. ` +
          `Usa TL;DR primero. No uses emojis. No contactes a terceros. ` +
          `No ejecutes acciones irreversibles.\n\nAlertas:\n${alertsText}`,
        {
          projectDir: CONFIG.kimi.projectDir,
          project: "default",
          summary: "",
        }
      );

      const text = response.error
        ? `*Alertas de infraestructura:*\n${alertsText}`
        : response.answer;

      try {
        await sendReply(homeGroup, text);
        await recordOutgoing(homeGroup, text, "default");
      } catch (err) {
        console.error("Failed to send consolidated alert to group", homeGroup, err);
        // Do not mark as sent if dispatch failed; they will be retried.
        continue;
      }

      // Record sent alerts.
      for (const alert of newAlerts) {
        sentAlerts.push({ date: today, alert, sentAt: new Date().toISOString() });
      }

      // Keep only the last 30 days to prevent unbounded growth.
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const filtered = sentAlerts.filter((entry) => new Date(entry.sentAt) >= cutoff);

      await saveSentAlerts(filtered);
      await unlink(ALERTS_FILE);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("Alert poller error:", err);
      }
    }
  }
}

async function main() {
  if (CONFIG.whatsapp.ownerNumbers.length === 0) {
    console.warn(
      "⚠️  CONFIG.whatsapp.ownerNumbers esta vacio. Edita src/config.js y agrega tu numero en formato 51999999999@s.whatsapp.net antes de que el bot te reconozca como owner."
    );
  }

  await initLcmDb();
  console.log("LCM inicializado en /home/ubuntu/projects/jarvis/data/jarvis-lcm.db");

  const projects = await listProjects();
  console.log("Projects disponibles:", projects.join(", "));

  sock = await startBaileys(handleMessage, {
    onSocketUpdate: (newSock) => {
      sock = newSock;
    },
  });
  console.log("Kimi EA/CoS runtime iniciado.");
  proactiveLoop();
  alertPoller();
  approvalCleanupLoop();
  policyCleanupLoop();
  startScheduler(sock);
  cleanupLoop();
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === process.argv[1];

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
