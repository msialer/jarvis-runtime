import { readFile } from "fs/promises";
import { logTurn } from "../src/audit-logger.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Prueba de audit logger ===\n");

  const entry = await logTurn({
    chatJid: "test@example.com",
    authorJid: "owner@s.whatsapp.net",
    project: "default",
    incoming: "Revisá mi calendario",
    outgoing: "Encontré 3 eventos hoy.",
    prompt: "Prompt de prueba largo...",
    kimiResponse: {
      answer: "Encontré 3 eventos hoy.",
      toolCalls: [{ name: "calendar_list", arguments: {} }],
      error: null,
    },
    attachment: null,
    durationMs: 1234,
  });

  await assert(entry.promptPath, "Se guardó el archivo de prompt");
  await assert(entry.responsePath, "Se guardó el archivo de respuesta");
  await assert(entry.errorPath === null, "No se guardó archivo de error");
  await assert(entry.promptLength > 0, "Se registró la longitud del prompt");
  await assert(entry.toolCalls.length === 1, "Se registró el tool call");

  const promptContent = await readFile(entry.promptPath, "utf8");
  await assert(promptContent.includes("Prompt de prueba"), "El archivo de prompt contiene el prompt");

  console.log("\nAudit entry:", JSON.stringify(entry, null, 2));
  console.log("\n✓ Todos los checks pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
