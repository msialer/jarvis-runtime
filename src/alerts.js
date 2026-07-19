import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const ALERTS_FILE = "/home/ubuntu/projects/server/logs/alerts-pending.json";

export async function queueAlert(alerts) {
  const list = Array.isArray(alerts) ? alerts : [alerts];
  await mkdir(path.dirname(ALERTS_FILE), { recursive: true });

  let existing = [];
  try {
    const raw = await readFile(ALERTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  existing.push({
    timestamp: new Date().toISOString(),
    alerts: list,
  });

  await writeFile(ALERTS_FILE, JSON.stringify(existing, null, 2));
}
