import { execFile } from "child_process";
import { promisify } from "util";
import { CONFIG } from "../config.js";

const execFileAsync = promisify(execFile);

const MAX_RESULT_TEXT_LENGTH = 600;

export async function searchMemPalace(query, limit = 3) {
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
  // MemPalace add is available via MCP; for now we write to a file and mine later.
  // In production, use mempalace-mcp tools via runtime.
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
