import { execFile } from "child_process";
import { promisify } from "util";
import { CONFIG } from "../config.js";
import * as mcp from "./mempalace-mcp.js";

const execFileAsync = promisify(execFile);

const MAX_RESULT_TEXT_LENGTH = 600;

export async function searchMemPalace(query, limit = 3) {
  // Primary: MCP semantic search.
  try {
    const result = await mcp.search(query, { limit, max_distance: 1.5 });
    const results = (result && Array.isArray(result.results) ? result.results : [])
      .slice(0, limit)
      .map((r) => ({
        ...r,
        text:
          typeof r.text === "string"
            ? r.text.slice(0, MAX_RESULT_TEXT_LENGTH)
            : r.text,
      }));
    return { results };
  } catch (mcpErr) {
    console.error("MemPalace MCP search failed, falling back to CLI:", mcpErr.message);
  }

  // Fallback: CLI search.
  try {
    const { stdout } = await execFileAsync(
      CONFIG.mempalace.binary,
      ["search", query, "--results", String(limit)],
      {
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/home/ubuntu/.local/bin`,
        },
        timeout: 30000,
      }
    );
    const parsed = JSON.parse(stdout);
    if (parsed.results && Array.isArray(parsed.results)) {
      parsed.results = parsed.results.slice(0, limit).map((r) => ({
        ...r,
        text:
          typeof r.text === "string"
            ? r.text.slice(0, MAX_RESULT_TEXT_LENGTH)
            : r.text,
      }));
    }
    return parsed;
  } catch (err) {
    return { error: err.message, results: [] };
  }
}

export async function addToMemPalace(text, source, wing = "conversations") {
  // Primary: MCP add_drawer.
  try {
    const room = "snippets";
    const result = await mcp.addDrawer(wing, room, text, {
      source_file: source,
      added_by: CONFIG.memory.agentName,
    });
    return { success: true, drawer: result };
  } catch (mcpErr) {
    console.error("MemPalace MCP add_drawer failed, falling back to file:", mcpErr.message);
  }

  // Fallback: write to a file and mine later.
  const fs = await import("fs/promises");
  const path = await import("path");
  const conversationsDir = path.join(
    "/home/ubuntu/projects/jarvis/data/conversations",
    wing
  );
  await fs.mkdir(conversationsDir, { recursive: true });
  const filename = `${Date.now()}.md`;
  const filepath = path.join(conversationsDir, filename);
  await fs.writeFile(filepath, `# Conversation snippet\nSource: ${source}\n\n${text}\n`);
  return { success: true, file: filepath };
}

export async function mineConversations() {
  // Keep CLI mine for bulk ingestion; MCP mine is also available but CLI is stable.
  try {
    const { stdout } = await execFileAsync(
      CONFIG.mempalace.binary,
      ["mine", "/home/ubuntu/projects/jarvis/data/conversations", "--wing", "conversations"],
      {
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/home/ubuntu/.local/bin`,
        },
        timeout: 120000,
      }
    );
    return { success: true, output: stdout };
  } catch (err) {
    return { error: err.message };
  }
}

// Re-export MCP helpers for direct use by the runtime.
export {
  status as memPalaceStatus,
  listWings as memPalaceListWings,
  listRooms as memPalaceListRooms,
  kgQuery as memPalaceKgQuery,
  kgAdd as memPalaceKgAdd,
  kgInvalidate as memPalaceKgInvalidate,
  kgTimeline as memPalaceKgTimeline,
  kgStats as memPalaceKgStats,
  search as memPalaceSearchMcp,
  addDrawer as memPalaceAddDrawer,
  checkpoint as memPalaceCheckpoint,
  diaryRead as memPalaceDiaryRead,
  diaryWrite as memPalaceDiaryWrite,
  traverse as memPalaceTraverse,
  followTunnels as memPalaceFollowTunnels,
  listTunnels as memPalaceListTunnels,
  createTunnel as memPalaceCreateTunnel,
} from "./mempalace-mcp.js";
