import { summarizeConversation } from "./kimi-bridge.js";

export const LEAF_SUMMARY_MAX_CHARS = 1200;
export const CONDENSED_SUMMARY_MAX_CHARS = 2000;

export function formatMessagesForSummary(messages) {
  return messages
    .map((m) => {
      const role = m.role === "user" ? "Usuario" : "Asistente";
      return `${role}: ${m.content}`;
    })
    .join("\n\n---\n\n");
}

export function formatSummariesForCondensing(summaries) {
  return summaries
    .map(
      (s, i) =>
        `Resumen ${i + 1} (turnos ${s.startTurnIndex}-${s.endTurnIndex}):\n${s.content}`
    )
    .join("\n\n---\n\n");
}

export async function summarizeLeaf(messages, conversationState = {}) {
  if (!messages || messages.length === 0) return null;

  const historyText = formatMessagesForSummary(messages);
  const prompt =
    `Resumí la siguiente porción de conversación en 3-5 puntos clave que deban recordarse para continuarla después. ` +
    `Sé conciso, en español, y no pierdas detalles importantes (nombres, fechas, decisiones, montos, bancos, etc.).\n\n` +
    `${historyText}`;

  const result = await summarizeConversation(prompt);
  if (!result) return null;
  return truncateToChars(result, LEAF_SUMMARY_MAX_CHARS);
}

export async function summarizeCondensed(childSummaries) {
  if (!childSummaries || childSummaries.length === 0) return null;

  const summariesText = formatSummariesForCondensing(childSummaries);
  const prompt =
    `A continuación tenés varios resúmenes parciales de una conversación más larga. ` +
    `Condensalos en un único resumen coherente de 3-5 puntos clave, preservando los datos concretos ` +
    `(nombres, fechas, montos, decisiones, bancos, pendientes) y descartando lo redundante.\n\n` +
    `${summariesText}`;

  const result = await summarizeConversation(prompt);
  if (!result) return null;
  return truncateToChars(result, CONDENSED_SUMMARY_MAX_CHARS);
}

function truncateToChars(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}
