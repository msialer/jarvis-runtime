import { detectPolicyUpdateIntent, detectPolicyArea } from "../src/index.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Prueba de detección de intención de policy update ===\n");

  await assert(
    detectPolicyUpdateIntent("Nueva regla de calendario: nunca crear eventos sin confirmar"),
    "Detecta 'Nueva regla de calendario'"
  );
  await assert(
    detectPolicyUpdateIntent("Actualizá la policy de email para que ignore newsletters"),
    "Detecta 'Actualizá la policy de email'"
  );
  await assert(
    detectPolicyUpdateIntent("Desde ahora, cuando revises calendarios, empezá por el laboral"),
    "Detecta 'Desde ahora, cuando revises calendarios'"
  );
  await assert(
    detectPolicyUpdateIntent("De ahora en adelante, no uses emojis"),
    "Detecta 'De ahora en adelante'"
  );
  await assert(
    !detectPolicyUpdateIntent("¿Qué tengo en el calendario hoy?"),
    "No detecta pregunta normal como policy update"
  );

  await assert(
    detectPolicyArea("Nueva regla de calendario: ...") === "calendar",
    "Detecta área calendar"
  );
  await assert(
    detectPolicyArea("Actualizá la policy de email ...") === "email",
    "Detecta área email"
  );
  await assert(
    detectPolicyArea("Desde ahora, cuando revises mis gastos...") === "wealth",
    "Detecta área wealth"
  );
  await assert(
    detectPolicyArea("Nueva regla de salud: ...") === "health",
    "Detecta área health"
  );

  console.log("\n✓ Todos los checks pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
