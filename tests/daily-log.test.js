import { shouldGenerateDailyLog } from "../src/daily-log.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Pruebas de daily log ===\n");

  // Test 1: module loads and function exists.
  assert(typeof shouldGenerateDailyLog === "function", "shouldGenerateDailyLog es una función");

  // Test 2: the function returns a boolean (actual result depends on current Lima time).
  const result = shouldGenerateDailyLog();
  assert(typeof result === "boolean", `shouldGenerateDailyLog devuelve booleano (${result})`);

  // Note: full generateDailyLog test requires valid OAuth tokens and network access.
  console.log("\n✓ Checks básicos de daily log pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
