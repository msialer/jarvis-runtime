import { callMcpTool } from "../mcp-client.js";
import { CONFIG } from "../config.js";

const DEFAULT_TIMEOUT_MS = 30000;

function parseMcpResult(result) {
  if (!result) return null;
  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    const joined = texts.join("");
    if (!joined) return result;
    try {
      return JSON.parse(joined);
    } catch {
      return { text: joined, raw: result };
    }
  }
  return result;
}

async function callServer(serverName, toolName, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const config = CONFIG.mcpServers[serverName];
  if (!config) {
    throw new Error(`MCP server '${serverName}' not configured`);
  }
  const result = await callMcpTool(serverName, config, toolName, args, timeoutMs);
  return parseMcpResult(result);
}

// Calendar
export async function calendarListCalendars() {
  return callServer("calendar", "calendar_list_calendars", {});
}

export async function calendarList(options = {}) {
  return callServer("calendar", "calendar_list", options);
}

// Gmail
export async function gmailSearch(query, maxResults = 20) {
  return callServer("gmail", "gmail_search", { query, max_results: maxResults });
}

// Tasks
export async function tasksList(maxResults = 50) {
  return callServer("tasks", "tasks_list", { max_results: maxResults });
}

// Metrics
export async function metricsList(domain) {
  const args = domain ? { domain } : {};
  return callServer("metrics", "metrics_list", args);
}

export async function metricsQuery(domain, name, limit = 10) {
  return callServer("metrics", "metrics_query", { domain, name, limit });
}

export async function metricsRecord(domain, name, value, unit, source, notes) {
  const args = { domain, name };
  if (value !== undefined && value !== null) args.value = String(value);
  if (unit) args.unit = unit;
  if (source) args.source = source;
  if (notes) args.notes = notes;
  return callServer("metrics", "metrics_record", args);
}
