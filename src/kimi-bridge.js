import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { CONFIG } from "./config.js";
import { loadAllPolicies } from "./policy-manager.js";

const execFileAsync = promisify(execFile);

async function loadKimiMd(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.trim();
  } catch {
    return "";
  }
}

export async function askKimi(prompt, context = {}) {
  const { projectDir, summary } = context;

  // Load both the project root manual and the per-project manual. The root
  // manual defines identity, tools and policies; the project manual adds
  // focus-specific rules.
  const rootKimiMd = await loadKimiMd(path.join(CONFIG.kimi.projectDir, "KIMI.md"));
  const projectKimiMd = projectDir
    ? await loadKimiMd(path.join(projectDir, "KIMI.md"))
    : "";

  // Load dynamic policies from the procedural memory vault.
  const policies = await loadAllPolicies();

  const enrichedPrompt = buildPrompt(prompt, context, rootKimiMd, projectKimiMd, policies);

  // Always run Kimi from the project root so it finds .kimi-code/mcp.json,
  // .kimi-code/skills/, and other shared configuration.
  const cwd = CONFIG.kimi.projectDir;

  // Stateless: do NOT reuse Kimi sessions. Each message starts fresh so that
  // MCP servers are discovered reliably and sessions are never tied to a stale
  // working directory. Context is kept by the runtime via `summary` and
  // MemPalace, not by Kimi's native session memory.
  const args = ["-p", enrichedPrompt, "--output-format", "stream-json"];

  try {
    const { stdout, stderr } = await execFileAsync(
      CONFIG.kimi.binary,
      args,
      {
        cwd,
        timeout: CONFIG.kimi.timeoutMs,
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/home/ubuntu/.local/bin`,
        },
      }
    );

    const { content, toolCalls } = parseStreamJson(stdout);

    return {
      answer: content,
      stderr: stderr || null,
      toolCalls,
      prompt: enrichedPrompt,
    };
  } catch (err) {
    return {
      error: err.message,
      stderr: err.stderr || null,
      toolCalls: [],
      prompt: enrichedPrompt,
    };
  }
}

function parseStreamJson(stdout) {
  const lines = stdout.trim().split("\n");
  const contents = [];
  const toolCalls = [];

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          contents.push(msg.content);
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const name =
              tc?.function?.name ||
              tc?.name ||
              (typeof tc === "string" ? tc : null);
            const args = tc?.function?.arguments ?? tc?.arguments ?? tc?.args ?? tc;
            if (name) {
              toolCalls.push({ name, arguments: args });
            }
          }
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return {
    content: contents.join("\n").trim(),
    toolCalls,
  };
}

const PROJECT_POLICY_MAP = {
  default: ["calendar", "email", "wealth", "health", "meetings", "proactive", "communication-style", "permissions"],
  health: ["health", "communication-style", "permissions"],
  wealth: ["wealth", "communication-style", "permissions"],
  career: ["calendar", "email", "meetings", "communication-style", "permissions"],
  strategy: ["meetings", "communication-style", "permissions"],
  personal: ["calendar", "email", "health", "wealth", "communication-style", "permissions"],
};

function selectRelevantPolicies(policies, project) {
  const relevant = PROJECT_POLICY_MAP[project] || PROJECT_POLICY_MAP.default;
  const set = new Set([...relevant, "communication-style", "permissions"]);
  return policies.filter((p) => set.has(p.name));
}

export function buildPrompt(userPrompt, context, rootKimiMd = "", projectKimiMd = "", policies = []) {
  const parts = [];

  if (rootKimiMd) {
    parts.push("--- JARVIS identity and tools ---");
    parts.push(rootKimiMd.slice(0, 4000));
    parts.push("--- End JARVIS identity and tools ---");
  }

  if (projectKimiMd) {
    parts.push("--- Project instructions ---");
    parts.push(projectKimiMd.slice(0, 1500));
    parts.push("--- End project instructions ---");
  }

  if (policies && policies.length > 0) {
    const relevantPolicies = selectRelevantPolicies(policies, context.project);
    parts.push("\n--- Active JARVIS policies ---");
    for (const policy of relevantPolicies) {
      parts.push(`\n## ${policy.name}`);
      parts.push(policy.content.slice(0, 800));
    }
    parts.push("\n--- End active JARVIS policies ---");
  }

  if (context.project) {
    parts.push(`Current JARVIS Project: ${context.project}`);
  }

  if (context.availableProjects && context.availableProjects.length > 0) {
    parts.push(`Available JARVIS Projects: ${context.availableProjects.join(", ")}`);
    parts.push(`Switch projects with: /project <name>. Create a new one with: /project create <name> [description]`);
  }

  if (context.summary) {
    parts.push("\n--- Resumen de la conversación anterior ---");
    parts.push(
      typeof context.summary === "string"
        ? context.summary.slice(0, 800)
        : context.summary
    );
  }

  if (context.conversationState) {
    const cs = context.conversationState;
    const csLines = [];
    if (cs.currentTopic) csLines.push(`- Tema actual: ${cs.currentTopic}`);
    if (cs.pendingAction) csLines.push(`- Acción pendiente: ${cs.pendingAction}`);
    if (cs.sharedFacts && Object.keys(cs.sharedFacts).length > 0) {
      csLines.push(`- Datos compartidos recientemente:`);
      for (const [k, v] of Object.entries(cs.sharedFacts)) {
        csLines.push(`  - ${k}: ${v}`);
      }
    }
    if (csLines.length > 0) {
      parts.push("\n--- Estado de la conversación ---");
      parts.push(csLines.join("\n"));
    }
  }

  if (context.recentMessages && context.recentMessages.length > 0) {
    const formatted = context.recentMessages
      .slice(-5)
      .map((m) => {
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 16) : "";
        const incoming = (m.incoming || "").slice(0, 300);
        const outgoing = (m.outgoing || "").slice(0, 300);
        const lines = [];
        if (incoming) lines.push(`[${ts}] Mauricio: ${incoming}`);
        if (outgoing) lines.push(`[${ts}] Kimi: ${outgoing}`);
        return lines.join("\n");
      })
      .join("\n");
    if (formatted.trim()) {
      parts.push("\n--- Hilo reciente ---");
      parts.push(formatted);
    }
  }

  if (context.sender) {
    parts.push(`\nMessage sender WhatsApp ID: ${context.sender}`);
  }

  if (context.isOwner) {
    parts.push("This message is from the owner (Mauricio).");
  }

  // Channel-agnostic capability reminder. WhatsApp is the primary interface
  // and must not restrict tool usage.
  parts.push("You can execute MCP tools (gmail_search, calendar_list, etc.) from any channel, including WhatsApp. Do not refuse to use tools just because the message arrived via WhatsApp.");

  if (context.memPalaceResults && context.memPalaceResults.length > 0) {
    parts.push("\n--- Relevant context from memory ---");
    for (const r of context.memPalaceResults.slice(0, 3)) {
      parts.push(`Source: ${r.source_file || r.source_path || "unknown"}`);
      parts.push(
        typeof r.text === "string" ? r.text.slice(0, 400) : r.text
      );
      parts.push("");
    }
  }

  if (context.metrics && context.metrics.length > 0) {
    parts.push("\n--- Recent metrics ---");
    for (const m of context.metrics.slice(0, 3)) {
      parts.push(`- ${m.domain}.${m.metric_name}: ${m.value} ${m.unit || ""} (${m.timestamp})`);
    }
  }

  if (context.attachment) {
    const a = context.attachment;
    parts.push("\n--- Archivo adjunto de WhatsApp ---");
    parts.push(`Ruta local: ${a.path}`);
    parts.push(`Tipo: ${a.type}`);
    parts.push(`MIME type: ${a.mimetype}`);
    parts.push(`Nombre original: ${a.originalName || a.filename}`);
    parts.push(`Tamaño: ${(a.size / 1024).toFixed(1)} KB`);
    if (a.caption) {
      parts.push(`Caption: ${a.caption}`);
    }

    if (a.type === "audio" || a.type === "ptt") {
      if (a.transcription) {
        parts.push("Transcripción automática (whisper.cpp ggml-base):");
        parts.push(a.transcription);
      } else if (a.transcriptionError) {
        parts.push(`Error en transcripción: ${a.transcriptionError}`);
      }
    } else if (a.extracted) {
      parts.push(`Archivo comprimido extraído en: ${a.extracted.path}`);
      parts.push(`Tipo de archivo: ${a.extracted.type}`);
      parts.push(`Cantidad de archivos: ${a.extracted.fileCount}`);
      parts.push("Contenido (primeros 100 elementos):");
      for (const f of a.extracted.files) {
        const sizeInfo = f.type === "file" ? ` (${(f.size / 1024).toFixed(1)} KB)` : "";
        parts.push(`- [${f.type}] ${f.path}${sizeInfo}`);
      }
      parts.push(
        "Si necesitás leer algún archivo del contenido extraído, usá la ruta completa con las herramientas nativas de Kimi Code CLI."
      );
    } else if (a.extractionError) {
      parts.push(`Error al extraer el archivo comprimido: ${a.extractionError}`);
    } else if (a.type === "image" || a.mimetype === "application/pdf") {
      parts.push(
        "Podés leer/analizar este archivo con las herramientas nativas de Kimi Code CLI (read, etc.)."
      );
    } else if (a.type === "video") {
      parts.push(
        "Este es un video. No se reproduce automáticamente; pedí al usuario que te describa lo que necesita si es relevante."
      );
    } else {
      parts.push(
        "Si necesitás inspeccionar el archivo, usá las herramientas nativas de Kimi Code CLI."
      );
    }
  }

  parts.push("\n--- User message ---");
  parts.push(userPrompt);

  return parts.join("\n");
}

export async function summarizeConversation(historyText) {
  const prompt = `Resume la siguiente conversación en 3-5 puntos clave que deban recordarse para continuarla después. Sé conciso y en español:\n\n${historyText}`;
  const result = await askKimi(prompt, {
    projectDir: CONFIG.kimi.projectDir,
  });
  return result.error ? "" : result.answer;
}

export function buildToolResultPrompt(originalUserPrompt, toolResults) {
  const lines = [
    "Ejecuté las siguientes herramientas solicitadas:",
    "",
  ];
  for (const r of toolResults) {
    lines.push(`Tool: ${r.name}`);
    lines.push(`Args: ${typeof r.args === "string" ? r.args : JSON.stringify(r.args)}`);
    lines.push(`Resultado: ${r.success ? "OK" : "ERROR"}`);
    lines.push(`Output: ${r.output || "(vacío)"}`);
    if (r.error) lines.push(`Error: ${r.error}`);
    lines.push("");
  }
  lines.push("Ahora respondé al mensaje original del usuario en español, sin emojis, basándote en los resultados anteriores.");
  lines.push("");
  lines.push("Mensaje original del usuario:");
  lines.push(originalUserPrompt);
  return lines.join("\n");
}
