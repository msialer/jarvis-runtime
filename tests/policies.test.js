import {
  listPolicies,
  getPolicy,
  updatePolicy,
  revertPolicy,
  loadAllPolicies,
} from "../src/policy-manager.js";
import { buildPrompt } from "../src/kimi-bridge.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Prueba del sistema de policies ===\n");

  // Test 1: list policies
  const policies = await listPolicies();
  await assert(policies.length >= 8, `Hay al menos 8 policies (encontradas: ${policies.length})`);
  await assert(policies.includes("calendar"), "Incluye policy calendar");
  await assert(policies.includes("email"), "Incluye policy email");
  await assert(policies.includes("permissions"), "Incluye policy permissions");

  // Test 2: get policy
  const calendar = await getPolicy("calendar");
  await assert(calendar.exists, "Policy calendar existe");
  await assert(calendar.content.includes("calendario"), "Policy calendar habla de calendario");

  // Test 3: update policy
  const updateResult = await updatePolicy(
    "calendar",
    calendar.content + "\n\n## Nueva regla de prueba\n\nEsta es una regla de prueba.\n",
    "Test update"
  );
  await assert(updateResult.hasBackup, "Se creó backup al actualizar");

  const calendarUpdated = await getPolicy("calendar");
  await assert(
    calendarUpdated.content.includes("Nueva regla de prueba"),
    "Policy calendar actualizada con la nueva regla"
  );

  // Test 4: revert policy
  await revertPolicy("calendar");
  const calendarReverted = await getPolicy("calendar");
  await assert(
    !calendarReverted.content.includes("Nueva regla de prueba"),
    "Policy calendar revertida correctamente"
  );

  // Test 5: load all policies and inject into prompt
  const allPolicies = await loadAllPolicies();
  await assert(allPolicies.length >= 8, "loadAllPolicies carga todas las policies");

  const prompt = buildPrompt(
    "Revisá mi calendario",
    {
      project: "default",
      availableProjects: ["default"],
      sender: "test@example.com",
      chat: "test@example.com",
      isOwner: true,
      isGroup: false,
      memPalaceResults: [],
      recentMessages: [],
      conversationState: {},
      originalPrompt: "Revisá mi calendario",
    },
    "",
    "",
    allPolicies
  );

  await assert(
    prompt.includes("--- Active JARVIS policies ---"),
    "Prompt incluye sección de policies"
  );
  await assert(prompt.includes("## calendar"), "Prompt incluye policy calendar");
  await assert(prompt.includes("## email"), "Prompt incluye policy email");

  console.log("\n✓ Todos los checks pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
