import { readFile, writeFile, copyFile } from "fs/promises";
import path from "path";
import {
  addRecentMessage,
  getRecentMessages,
  updateConversationState,
  getConversationState,
  clearPendingAction,
} from "../src/session-manager.js";
import { buildPrompt } from "../src/kimi-bridge.js";

const SESSIONS_FILE = "/home/ubuntu/projects/jarvis/data/sessions.json";
const BACKUP_FILE = `/home/ubuntu/projects/jarvis/data/sessions.json.bak.test-${Date.now()}`;
const TEST_CHAT = "test-bcp-dni@example.com";

// --- Copias de las funciones de index.js para pruebas sin levantar el runtime ---

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
  const nextState = {
    currentTopic: prevState.currentTopic,
    pendingAction: prevState.pendingAction,
    sharedFacts: { ...prevState.sharedFacts },
    lastIntent: prevState.lastIntent,
  };

  const dniMatch = text.match(/\b\d{8,12}\b/);
  if (dniMatch && lowerText.includes("dni")) {
    nextState.sharedFacts.dni = dniMatch[0];
    nextState.currentTopic = "datos personales";
  }

  if (/\brevis\w*\s+(el\s+)?estado de cuenta\b/i.test(text)) {
    nextState.pendingAction = "revisar estado de cuenta";
    const bankMatch = text.match(/\b(BCP|Interbank|BBVA|Scotiabank|Banbif|MiBanco)\b/i);
    if (bankMatch) {
      nextState.sharedFacts.banco = bankMatch[0];
      nextState.currentTopic = `estado de cuenta ${bankMatch[0]}`;
    }
  }

  if (/\bestado de cuenta\b/i.test(text)) nextState.currentTopic = "estado de cuenta";
  if (/\bpeso\b/i.test(text)) nextState.currentTopic = "peso";
  if (/\bgasto\b/i.test(text)) nextState.currentTopic = "gasto";
  if (/\breunión\b/i.test(text)) nextState.currentTopic = "reunión";

  if (looksLikeCompletion(reply, prevState.pendingAction)) {
    nextState.pendingAction = "";
  }

  if (/\b(revisá|buscá|encontrá|mandá|enviá|pagá|registrá|recordá|recordame|avísame)\b/i.test(text)) {
    nextState.pendingAction = text.slice(0, 120);
  }

  return nextState;
}

function inferStateFromOutgoing(outgoing, prevState) {
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
  return text;
}

// --- Test ---

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Simulación hilo BCP → DNI ===\n");

  await copyFile(SESSIONS_FILE, BACKUP_FILE);
  console.log(`Backup creado: ${BACKUP_FILE}\n`);

  try {
    // Paso 1: Kimi envía alerta proactiva sobre BCP.
    const proactiveMessage =
      "TL;DR: Tienes un email que requiere atención: pago de tarjeta de crédito BCP con fecha límite 21/07.\n\n" +
      "1. Estados de Cuenta BCP\n" +
      "- Asunto: Estado de Cuenta de tu Tarjeta VISA\n" +
      "- Por qué importa: El último día de pago es 21/07/2026.\n" +
      "- Acción propuesta: Revisar el estado de cuenta adjunto.";

    await addRecentMessage(TEST_CHAT, {
      author: null,
      incoming: null,
      outgoing: proactiveMessage,
      project: "default",
    });

    let state = await getConversationState(TEST_CHAT);
    let nextState = inferStateFromOutgoing(proactiveMessage, state);
    await updateConversationState(TEST_CHAT, nextState);

    state = await getConversationState(TEST_CHAT);
    await assert(state.sharedFacts.banco === "BCP", "Banco BCP detectado en sharedFacts");
    await assert(
      state.pendingAction.toLowerCase().includes("revisar") &&
        state.pendingAction.toLowerCase().includes("bcp"),
      "Acción pendiente: revisar estado de cuenta BCP"
    );

    // Paso 2: Mauricio responde con el DNI.
    const userMessage =
      "Mi DNI es 43065216. Registralo para revisar el estado de cuenta (ahora y a futuro)";
    const expandedUserMessage = expandPromptWithContext(userMessage, state);

    await assert(
      expandedUserMessage.includes("Contexto interno") &&
        expandedUserMessage.includes("acción pendiente"),
      "Prompt expandido con contexto interno de acción pendiente"
    );

    // Paso 3: Simular respuesta de Kimi (no importa el contenido para este test).
    const fakeReply = "Entendido. Voy a buscar el estado de cuenta de BCP.";
    nextState = inferConversationState(userMessage, fakeReply, state);
    await updateConversationState(TEST_CHAT, nextState);

    state = await getConversationState(TEST_CHAT);
    await assert(state.sharedFacts.dni === "43065216", "DNI 43065216 guardado en sharedFacts");

    // Paso 4: Construir el prompt que vería Kimi y verificar que contiene el contexto.
    const recentMessages = await getRecentMessages(TEST_CHAT, 10);
    const context = {
      project: "default",
      availableProjects: ["default", "health", "wealth", "career", "strategy", "personal"],
      summary: "",
      sender: TEST_CHAT,
      chat: TEST_CHAT,
      isOwner: true,
      isGroup: false,
      memPalaceResults: [],
      proactiveMemPalaceResults: [],
      recentMessages,
      conversationState: state,
      originalPrompt: userMessage,
    };

    const rootKimiMd = await readFile(
      "/home/ubuntu/projects/jarvis/KIMI.md",
      "utf8"
    ).catch(() => "");
    const prompt = buildPrompt(expandedUserMessage, context, rootKimiMd, "");

    await assert(
      prompt.includes("Estado de la conversación"),
      "Prompt incluye sección 'Estado de la conversación'"
    );
    await assert(
      prompt.includes("Hilo reciente"),
      "Prompt incluye sección 'Hilo reciente'"
    );
    await assert(
      prompt.includes("BCP") && prompt.includes("43065216"),
      "Prompt incluye BCP y DNI en el contexto"
    );
    await assert(
      prompt.includes("revisar estado de cuenta BCP") ||
        prompt.includes("revisar pago de tarjeta BCP"),
      "Prompt incluye la acción pendiente"
    );
    await assert(
      prompt.includes("Contexto interno") && prompt.includes("acción pendiente"),
      "Prompt incluye la instrucción interna de ejecutar acción pendiente"
    );

    console.log("\n=== RESULTADO ===");
    console.log("Prompt generado (primeros 2000 chars):");
    console.log(prompt.slice(0, 2000));
    console.log("\n✓ Todos los checks pasaron.");
  } finally {
    await copyFile(BACKUP_FILE, SESSIONS_FILE);
    console.log("\nBackup restaurado.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
