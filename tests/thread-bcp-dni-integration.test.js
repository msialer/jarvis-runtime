import { readFile, copyFile } from "fs/promises";
import {
  addRecentMessage,
  getRecentMessages,
  updateConversationState,
  getConversationState,
} from "../src/session-manager.js";
import { buildPrompt, askKimi } from "../src/kimi-bridge.js";

const SESSIONS_FILE = "/home/ubuntu/projects/jarvis/data/sessions.json";
const BACKUP_FILE = `/home/ubuntu/projects/jarvis/data/sessions.json.bak.integration-${Date.now()}`;
const TEST_CHAT = "test-bcp-dni-integration@example.com";

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
  return nextState;
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
  if (/\b(revisá|buscá|encontrá|mandá|enviá|pagá|registrá|recordá|recordame|avísame)\b/i.test(text)) {
    nextState.pendingAction = text.slice(0, 120);
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

async function main() {
  console.log("=== Integración BCP → DNI con Kimi real ===\n");

  await copyFile(SESSIONS_FILE, BACKUP_FILE);

  try {
    const proactiveMessage =
      "TL;DR: Tienes un email que requiere atención: pago de tarjeta de crédito BCP con fecha límite 21/07.\n\n" +
      "1. Estados de Cuenta BCP\n" +
      "- Asunto: Estado de Cuenta de tu Tarjeta VISA\n" +
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

    const userMessage =
      "Mi DNI es 43065216. Registralo para revisar el estado de cuenta (ahora y a futuro)";
    state = await getConversationState(TEST_CHAT);
    const expandedUserMessage = expandPromptWithContext(userMessage, state);
    nextState = inferConversationState(userMessage, "", state);
    await updateConversationState(TEST_CHAT, nextState);

    state = await getConversationState(TEST_CHAT);
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

    const rootKimiMd = await readFile("/home/ubuntu/projects/jarvis/KIMI.md", "utf8").catch(
      () => ""
    );
    const prompt = buildPrompt(expandedUserMessage, context, rootKimiMd, "");

    console.log("Prompt listo. Llamando a Kimi...\n");
    const response = await askKimi(prompt, {
      projectDir: "/home/ubuntu/projects/jarvis",
      project: "default",
    });

    if (response.error) {
      console.error("Error de Kimi:", response.error);
      process.exit(1);
    }

    console.log("=== Respuesta de Kimi ===");
    console.log(response.answer);
    console.log("\n=== Evaluación ===");

    const answer = (response.answer || "").toLowerCase();
    const passivePatterns = [
      /¿de qué banco/,
      /¿cómo querés avanzar/,
      /¿cómo preferís avanzar/,
      /¿qué querés que haga/,
      /decime cómo/,
      /no usaré bash/,
      /voy a verificar primero/,
      /para revisar el estado de cuenta ahora, necesito/,
    ];

    let isPassive = false;
    for (const re of passivePatterns) {
      if (re.test(answer)) {
        console.log(`✗ Detectado patrón pasivo: ${re.source}`);
        isPassive = true;
      }
    }

    const hasAction =
      /busc|revis|consult|buscar|revisar|consultar/.test(answer) &&
      (/bcp/.test(answer) || /estado de cuenta/.test(answer));

    if (hasAction) {
      console.log("✓ La respuesta indica acción concreta (buscar/revisar BCP).");
    } else {
      console.log("✗ La respuesta no indica acción concreta sobre BCP.");
    }

    if (!isPassive && hasAction) {
      console.log("\n✓ Test de integración pasado.");
    } else {
      console.log("\n✗ Test de integración falló.");
      process.exit(1);
    }
  } finally {
    await copyFile(BACKUP_FILE, SESSIONS_FILE);
    console.log("\nBackup restaurado.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
