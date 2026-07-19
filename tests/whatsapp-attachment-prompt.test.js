import { readFile } from "fs/promises";
import { buildPrompt } from "../src/kimi-bridge.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Prueba de prompt con archivo adjunto ===\n");

  const rootKimiMd = await readFile("/home/ubuntu/projects/jarvis/KIMI.md", "utf8").catch(
    () => ""
  );

  const attachment = {
    path: "/home/ubuntu/projects/jarvis/data/downloads/whatsapp/2026-07-16T07-00-00_000_test.pdf",
    filename: "2026-07-16T07-00-00_000_test.pdf",
    originalName: "estado-de-cuenta-bcp.pdf",
    mimetype: "application/pdf",
    size: 45678,
    caption: "Estado de cuenta BCP",
    type: "document",
  };

  const context = {
    project: "default",
    availableProjects: ["default", "health", "wealth", "career", "strategy", "personal"],
    summary: "",
    sender: "test@example.com",
    chat: "test@example.com",
    isOwner: true,
    isGroup: false,
    memPalaceResults: [],
    proactiveMemPalaceResults: [],
    recentMessages: [],
    conversationState: {},
    originalPrompt: "Revisá este estado de cuenta",
    attachment,
  };

  const prompt = buildPrompt("Revisá este estado de cuenta", context, rootKimiMd, "");

  await assert(
    prompt.includes("--- Archivo adjunto de WhatsApp ---"),
    "Prompt incluye sección de archivo adjunto"
  );
  await assert(prompt.includes(attachment.path), "Prompt incluye la ruta local del archivo");
  await assert(prompt.includes(attachment.mimetype), "Prompt incluye el MIME type");
  await assert(
    prompt.includes(attachment.originalName),
    "Prompt incluye el nombre original del archivo"
  );
  await assert(prompt.includes(attachment.caption), "Prompt incluye la caption");
  await assert(
    prompt.includes("Podés leer/analizar este archivo"),
    "Prompt incluye instrucción para leer/analizar PDF"
  );

  console.log("\n=== Prompt generado (sección relevante) ===");
  const start = prompt.indexOf("--- Archivo adjunto de WhatsApp ---");
  console.log(prompt.slice(start, start + 600));
  console.log("\n✓ Todos los checks pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
