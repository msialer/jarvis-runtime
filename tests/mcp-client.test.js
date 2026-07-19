import { callMcpTool, listMcpTools, closeAllMcpConnections } from "../src/mcp-client.js";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

async function main() {
  console.log("=== Pruebas de MCP client ===\n");

  const mempalaceConfig = {
    command: "/home/ubuntu/.local/bin/mempalace-mcp",
    args: ["--palace", "/home/ubuntu/.mempalace/palace", "--transport", "stdio"],
  };

  // Test 1: status tool returns palace overview.
  const status = await callMcpTool("mempalace", mempalaceConfig, "mempalace_status", {}, 30000);
  assert(status && status.content, "mempalace_status devuelve content");
  const parsedStatus = JSON.parse(status.content[0].text);
  assert(parsedStatus.total_drawers >= 0, `total_drawers es un número (${parsedStatus.total_drawers})`);
  assert(parsedStatus.wings && typeof parsedStatus.wings === "object", "wings es un objeto");

  // Test 2: list tools.
  const tools = await listMcpTools("mempalace", mempalaceConfig, 30000);
  assert(Array.isArray(tools), "listMcpTools devuelve un array");
  assert(tools.some((t) => t.name === "mempalace_kg_query"), "mempalace_kg_query está disponible");
  assert(tools.some((t) => t.name === "mempalace_diary_read"), "mempalace_diary_read está disponible");

  // Test 3: add a drawer and read it back via search.
  const uniqueMarker = `test-mcp-client-${Date.now()}`;
  const addResult = await callMcpTool(
    "mempalace",
    mempalaceConfig,
    "mempalace_add_drawer",
    {
      wing: "jarvis",
      room: "test",
      content: `Drawer de prueba del MCP client: ${uniqueMarker}`,
    },
    30000
  );
  assert(addResult && addResult.content, "add_drawer devuelve content");

  const searchResult = await callMcpTool(
    "mempalace",
    mempalaceConfig,
    "mempalace_search",
    { query: uniqueMarker, wing: "jarvis", limit: 1 },
    30000
  );
  assert(searchResult && searchResult.content, "search devuelve content");
  const parsedSearch = JSON.parse(searchResult.content[0].text);
  assert(
    parsedSearch.results && parsedSearch.results.some((r) => r.text && r.text.includes(uniqueMarker)),
    "search encuentra el drawer recién creado"
  );

  await closeAllMcpConnections();
  console.log("\n✓ Todos los checks de MCP client pasaron.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
