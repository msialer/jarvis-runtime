import { callMcpTool } from "../mcp-client.js";
import { CONFIG } from "../config.js";

const MEMPALACE_TIMEOUT_MS = 30000;

function getServerConfig() {
  return CONFIG.mcpServers.mempalace;
}

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

async function callMemPalace(toolName, args, timeoutMs = MEMPALACE_TIMEOUT_MS) {
  const result = await callMcpTool("mempalace", getServerConfig(), toolName, args, timeoutMs);
  return parseMcpResult(result);
}

export async function status() {
  return callMemPalace("mempalace_status", {});
}

export async function listWings() {
  return callMemPalace("mempalace_list_wings", {});
}

export async function listRooms(wing) {
  return callMemPalace("mempalace_list_rooms", wing ? { wing } : {});
}

export async function kgQuery(entity, options = {}) {
  const args = { entity, ...options };
  return callMemPalace("mempalace_kg_query", args);
}

export async function kgAdd(subject, predicate, object, options = {}) {
  const args = { subject, predicate, object, ...options };
  return callMemPalace("mempalace_kg_add", args);
}

export async function kgInvalidate(subject, predicate, object, ended) {
  const args = { subject, predicate, object };
  if (ended) args.ended = ended;
  return callMemPalace("mempalace_kg_invalidate", args);
}

export async function kgTimeline(entity) {
  const args = entity ? { entity } : {};
  return callMemPalace("mempalace_kg_timeline", args);
}

export async function kgStats() {
  return callMemPalace("mempalace_kg_stats", {});
}

export async function search(query, options = {}) {
  const args = { query, ...options };
  return callMemPalace("mempalace_search", args);
}

export async function addDrawer(wing, room, content, options = {}) {
  const args = { wing, room, content, ...options };
  return callMemPalace("mempalace_add_drawer", args);
}

export async function checkpoint(items, diary, dedupThreshold = 0.9) {
  const args = {
    items: items.map((item) => ({
      wing: item.wing,
      room: item.room,
      content: item.content,
    })),
    dedup_threshold: dedupThreshold,
  };
  if (diary) {
    args.diary = {
      agent_name: diary.agentName,
      entry: diary.entry,
      topic: diary.topic || "general",
      wing: diary.wing,
    };
  }
  return callMemPalace("mempalace_checkpoint", args);
}

export async function diaryRead(agentName, lastN = 10, wing) {
  const args = { agent_name: agentName, last_n: lastN };
  if (wing) args.wing = wing;
  return callMemPalace("mempalace_diary_read", args);
}

export async function diaryWrite(agentName, entry, topic = "general", wing) {
  const args = { agent_name: agentName, entry, topic };
  if (wing) args.wing = wing;
  return callMemPalace("mempalace_diary_write", args);
}

export async function traverse(startRoom, maxHops = 2) {
  return callMemPalace("mempalace_traverse", { start_room: startRoom, max_hops: maxHops });
}

export async function followTunnels(wing, room) {
  return callMemPalace("mempalace_follow_tunnels", { wing, room });
}

export async function listTunnels(wing) {
  return callMemPalace("mempalace_list_tunnels", wing ? { wing } : {});
}

export async function createTunnel(sourceWing, sourceRoom, targetWing, targetRoom, label) {
  const args = {
    source_wing: sourceWing,
    source_room: sourceRoom,
    target_wing: targetWing,
    target_room: targetRoom,
  };
  if (label) args.label = label;
  return callMemPalace("mempalace_create_tunnel", args);
}
