import { execFile } from "child_process";
import { promisify } from "util";
import { CONFIG } from "../config.js";

const execFileAsync = promisify(execFile);

export async function recordMetric({ domain, name, value, unit, source, notes }) {
  try {
    const args = [
      CONFIG.metrics.script,
      "record",
      "--domain", domain,
      "--name", name,
    ];
    if (value !== undefined && value !== null) args.push("--value", String(value));
    if (unit) args.push("--unit", unit);
    if (source) args.push("--source", source);
    if (notes) args.push("--notes", notes);

    const { stdout } = await execFileAsync("python3", args, { timeout: 10000 });
    return JSON.parse(stdout);
  } catch (err) {
    return { error: err.message };
  }
}

export async function listMetrics(domain) {
  try {
    const args = [CONFIG.metrics.script, "list"];
    if (domain) args.push("--domain", domain);
    const { stdout } = await execFileAsync("python3", args, { timeout: 10000 });
    return JSON.parse(stdout);
  } catch (err) {
    return { error: err.message };
  }
}

export async function queryMetric(domain, name, limit = 10) {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [CONFIG.metrics.script, "query", "--domain", domain, "--name", name, "--limit", String(limit)],
      { timeout: 10000 }
    );
    return JSON.parse(stdout);
  } catch (err) {
    return { error: err.message };
  }
}

export async function detectMetric(domain, name) {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [CONFIG.metrics.script, "detect", "--domain", domain, "--name", name],
      { timeout: 10000 }
    );
    return JSON.parse(stdout);
  } catch (err) {
    return { error: err.message };
  }
}
