import { readFile } from "fs/promises";
import { buildPrompt } from "../src/kimi-bridge.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Prueba de prompt con audio transcrito y ZIP extraído ===\n");

  const rootKimiMd = await readFile("/home/ubuntu/projects/jarvis/KIMI.md", "utf8").catch(() => "");

  // Test 1: Audio transcrito
  const audioAttachment = {
    path: "/home/ubuntu/projects/jarvis/data/downloads/whatsapp/2026-07-16T08-00-00_000_audio.ogg",
    filename: "2026-07-16T08-00-00_000_audio.ogg",
    originalName: "PTT-20260716.ogg",
    mimetype: "audio/ogg",
    size: 12345,
    caption: "",
    type: "ptt",
    transcription: "Mauricio, acordate de revisar el estado de cuenta del BCP antes del lunes.",
  };

  let prompt = buildPrompt("Resumí lo que dije", {
    project: "default",
    availableProjects: ["default"],
    sender: "test@example.com",
    chat: "test@example.com",
    isOwner: true,
    isGroup: false,
    memPalaceResults: [],
    recentMessages: [],
    conversationState: {},
    originalPrompt: "Resumí lo que dije",
    attachment: audioAttachment,
  }, rootKimiMd, "");

  await assert(
    prompt.includes("Transcripción automática (whisper.cpp ggml-base)"),
    "Prompt indica que hay transcripción automática"
  );
  await assert(
    prompt.includes(audioAttachment.transcription),
    "Prompt incluye el texto transcrito"
  );

  // Test 2: ZIP extraído
  const zipAttachment = {
    path: "/home/ubuntu/projects/jarvis/data/downloads/whatsapp/2026-07-16T08-00-00_000_archivo.zip",
    filename: "2026-07-16T08-00-00_000_archivo.zip",
    originalName: "documentos.zip",
    mimetype: "application/zip",
    size: 45678,
    caption: "Documentos importantes",
    type: "document",
    extracted: {
      path: "/home/ubuntu/projects/jarvis/data/downloads/whatsapp/documentos-12345",
      type: "zip",
      fileCount: 3,
      files: [
        { path: "documentos", type: "directory" },
        { path: "documentos/contrato.pdf", type: "file", size: 10240 },
        { path: "documentos/factura.pdf", type: "file", size: 5120 },
        { path: "documentos/notas.txt", type: "file", size: 2048 },
      ],
    },
  };

  prompt = buildPrompt("Revisá estos documentos", {
    project: "default",
    availableProjects: ["default"],
    sender: "test@example.com",
    chat: "test@example.com",
    isOwner: true,
    isGroup: false,
    memPalaceResults: [],
    recentMessages: [],
    conversationState: {},
    originalPrompt: "Revisá estos documentos",
    attachment: zipAttachment,
  }, rootKimiMd, "");

  await assert(
    prompt.includes("Archivo comprimido extraído en"),
    "Prompt indica que el ZIP fue extraído"
  );
  await assert(
    prompt.includes(zipAttachment.extracted.path),
    "Prompt incluye la ruta de extracción"
  );
  await assert(
    prompt.includes("contrato.pdf") && prompt.includes("factura.pdf"),
    "Prompt lista los archivos extraídos"
  );

  console.log("\n✓ Todos los checks pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
