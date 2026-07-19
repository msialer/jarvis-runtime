import { readHandoff, writeHandoff, clearHandoff, formatHandoffForPrompt } from "../src/handoff.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Pruebas de handoff ===\n");

  // Test 1: write and read handoff.
  await writeHandoff({
    activeProject: "wealth",
    objective: "Revisar portafolio",
    progress: "Se identificaron activos actuales",
    blockers: "Falta acceso al broker",
    nextSteps: ["Solicitar credenciales", "Revisar asset allocation"],
  });

  const handoff = await readHandoff();
  assert(handoff.exists, "El handoff existe después de escribirlo");
  assert(handoff.parsed.active_project === "wealth", "Project activo es wealth");
  assert(handoff.parsed.objective === "Revisar portafolio", "Objetivo parseado correctamente");
  assert(handoff.parsed.next_steps.length === 2, "Hay 2 next steps");
  assert(handoff.parsed.next_steps[0] === "Solicitar credenciales", "Primer next step correcto");

  // Test 2: format for prompt.
  const promptLines = formatHandoffForPrompt(handoff);
  assert(promptLines.length > 0, "formatHandoffForPrompt devuelve líneas");
  const promptText = promptLines.join("\n");
  assert(promptText.includes("Revisar portafolio"), "El prompt incluye el objetivo");
  assert(promptText.includes("Solicitar credenciales"), "El prompt incluye el primer next step");

  // Test 3: clear handoff.
  await clearHandoff();
  const cleared = await readHandoff();
  assert(cleared.exists, "El handoff sigue existiendo después de limpiarlo");
  assert(cleared.parsed.objective === "(sin objetivo definido)", "Objetivo reseteado");
  assert(cleared.parsed.next_steps.length === 0, "Next steps vacíos después de limpiar");

  console.log("\n✓ Todos los checks de handoff pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
