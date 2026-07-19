import { askKimi } from "../src/kimi-bridge.js";

async function main() {
  console.log("Reproduciendo follow-up-check...\n");
  const response = await askKimi("/skill:follow-up-check", {
    projectDir: "/home/ubuntu/projects/jarvis/projects/default",
    project: "default",
    availableProjects: ["career", "default", "health", "personal", "strategy", "wealth"],
    summary: "Resumen de prueba largo...",
    sender: "120363424471921890@g.us",
    isOwner: true,
    isGroup: true,
    memPalaceResults: [],
  });

  if (response.error) {
    console.error("ERROR:", response.error);
    console.error("STDERR:", response.stderr);
    process.exit(1);
  }

  console.log("RESPUESTA:", response.answer);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
