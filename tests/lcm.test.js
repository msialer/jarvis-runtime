import fs from "fs/promises";

const TEST_DB_PATH = `/tmp/jarvis-lcm-test-${Date.now()}.db`;

// Set env BEFORE loading the LCM module so DB_PATH picks it up.
process.env.JARVIS_LCM_DB = TEST_DB_PATH;

const {
  initLcmDb,
  closeLcmDb,
  appendTurn,
  buildContext,
  createSummary,
  getMessageCount,
  searchMessages,
  getUnsummarizedMessageRange,
  getLeafSummariesReadyForCondensing,
  FRESH_TAIL_COUNT,
} = await import("../src/lcm.js");

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function cleanDb() {
  try {
    await fs.unlink(TEST_DB_PATH);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    await fs.unlink(TEST_DB_PATH + "-shm");
  } catch {}
  try {
    await fs.unlink(TEST_DB_PATH + "-wal");
  } catch {}
}

async function main() {
  console.log("=== Pruebas de LCM ===\n");

  process.env.JARVIS_LCM_DB = TEST_DB_PATH;
  await cleanDb();
  await initLcmDb();

  const chatJid = "test@example.com";
  const project = "default";

  // Test 1: empty context.
  let ctx = buildContext(chatJid, project);
  await assert(ctx.conversationId === null, "No hay conversation antes del primer mensaje");
  await assert(ctx.freshTail.length === 0, "Fresh tail vacío al inicio");
  await assert(ctx.summaries.length === 0, "Summaries vacíos al inicio");

  // Test 2: append messages.
  for (let i = 0; i < 6; i++) {
    appendTurn({
      chatJid,
      project,
      role: "user",
      content: `Pregunta ${i + 1}`,
      authorJid: chatJid,
      timestamp: new Date().toISOString(),
    });
    appendTurn({
      chatJid,
      project,
      role: "assistant",
      content: `Respuesta ${i + 1}`,
      authorJid: null,
      timestamp: new Date().toISOString(),
    });
  }

  const count = getMessageCount(chatJid, project);
  await assert(count === 12, `Hay 12 mensajes guardados (tenemos ${count})`);

  ctx = buildContext(chatJid, project);
  await assert(ctx.freshTail.length === FRESH_TAIL_COUNT, "Fresh tail contiene los últimos 10 mensajes");
  await assert(ctx.summaries.length === 0, "No hay summaries aún");

  // Test 3: create leaf summaries manually (without calling LLM).
  const conversationId = ctx.conversationId;
  createSummary({
    conversationId,
    depth: 0,
    content: "Resumen de los turnos 0-3: se habló de preguntas iniciales.",
    startTurnIndex: 0,
    endTurnIndex: 3,
  });
  createSummary({
    conversationId,
    depth: 0,
    content: "Resumen de los turnos 4-7: se habló de preguntas intermedias.",
    startTurnIndex: 4,
    endTurnIndex: 7,
  });

  ctx = buildContext(chatJid, project);
  await assert(ctx.freshTail.length === FRESH_TAIL_COUNT, "Fresh tail protegido (últimos 10)");
  await assert(ctx.summaries.length === 1, "Un summary cubre los turnos fuera del fresh tail");
  await assert(ctx.summaries[0].startTurnIndex === 0, "El summary cubre desde el turno 0");
  await assert(ctx.summaries[0].endTurnIndex === 3, "El summary cubre hasta el turno 3 (que incluye el rango 0-1 previo al fresh tail)");

  // Test 4: create a condensed summary.
  const leaf1 = createSummary({
    conversationId,
    depth: 0,
    content: "Leaf A",
    startTurnIndex: 0,
    endTurnIndex: 3,
  });
  const leaf2 = createSummary({
    conversationId,
    depth: 0,
    content: "Leaf B",
    startTurnIndex: 4,
    endTurnIndex: 7,
  });
  const leaf3 = createSummary({
    conversationId,
    depth: 0,
    content: "Leaf C",
    startTurnIndex: 8,
    endTurnIndex: 11,
  });
  const leaf4 = createSummary({
    conversationId,
    depth: 0,
    content: "Leaf D",
    startTurnIndex: 12,
    endTurnIndex: 15,
  });

  createSummary({
    conversationId,
    depth: 1,
    content: "Condensed summary de leafs A-D",
    startTurnIndex: 0,
    endTurnIndex: 15,
    childSummaryIds: [leaf1, leaf2, leaf3, leaf4],
  });

  ctx = buildContext(chatJid, project);
  await assert(ctx.summaries.some((s) => s.depth === 1), "Hay al menos un summary condensado");

  // Test 5: FTS5 search.
  const results = searchMessages(chatJid, project, "Respuesta 5");
  await assert(results.length >= 1, "FTS5 encuentra al menos un mensaje con 'Respuesta 5'");
  await assert(
    results.some((r) => r.content.includes("Respuesta 5")),
    "El resultado de búsqueda contiene el mensaje esperado"
  );

  // Test 6: unsummarized range logic.
  const range = getUnsummarizedMessageRange(conversationId);
  await assert(range === null || range.startIndex > range.endIndex, "No hay mensajes fuera del fresh tail sin summarizar");

  closeLcmDb();
  await cleanDb();
  delete process.env.JARVIS_LCM_DB;

  console.log("\n✓ Todos los checks de LCM pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
