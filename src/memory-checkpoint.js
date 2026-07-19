import { CONFIG } from "./config.js";
import { checkpoint, diaryWrite, kgAdd, diaryRead, kgQuery, search } from "./tools/mempalace-mcp.js";

const JARVIS_WING = CONFIG.memory.wing;
const CONVERSATIONS_ROOM = CONFIG.memory.room;
const AGENT_NAME = CONFIG.memory.agentName;

function truncate(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n... (truncado)";
}

export async function checkpointTurn({ chatJid, project, incoming, outgoing, timestamp }) {
  try {
    const date = timestamp ? new Date(timestamp) : new Date();
    const dateStr = date.toISOString();
    const shortDate = dateStr.slice(0, 10);

    const conversationSnippet = [
      `## Turno ${dateStr}`,
      `Project: ${project || "default"}`,
      `Chat: ${chatJid || "unknown"}`,
      "",
      "**Usuario:**",
      truncate(incoming, CONFIG.memory.maxSnippetLength),
      "",
      "**JARVIS:**",
      truncate(outgoing, CONFIG.memory.maxSnippetLength),
    ].join("\n");

    const diaryEntry = [
      `SESSION:${shortDate}`,
      `project.${project || "default"}`,
      incoming ? `user.said:${truncate(incoming, 120).replace(/\s+/g, " ")}` : "",
      outgoing ? `agent.did:${truncate(outgoing, 120).replace(/\s+/g, " ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    await checkpoint(
      [
        {
          wing: JARVIS_WING,
          room: CONVERSATIONS_ROOM,
          content: conversationSnippet,
        },
      ],
      {
        agentName: AGENT_NAME,
        entry: diaryEntry,
        topic: project || "default",
      },
      CONFIG.memory.checkpointDedupThreshold
    );

    return { success: true };
  } catch (err) {
    console.error("checkpointTurn failed:", err);
    return { success: false, error: err.message };
  }
}

export async function recordFacts(facts, source) {
  const results = [];
  for (const fact of facts) {
    try {
      const { subject, predicate, object, valid_from, valid_to } = fact;
      if (!subject || !predicate || !object) continue;
      await kgAdd(subject, predicate, object, {
        valid_from,
        valid_to,
        source_file: source,
      });
      results.push({ subject, predicate, object, success: true });
    } catch (err) {
      results.push({ ...fact, success: false, error: err.message });
    }
  }
  return results;
}

export async function writeAgentDiary(entry, topic = "general") {
  try {
    return await diaryWrite(AGENT_NAME, entry, topic, JARVIS_WING);
  } catch (err) {
    console.error("writeAgentDiary failed:", err);
    return { error: err.message };
  }
}

function extractEntities(text) {
  if (!text) return [];
  // Simple entity extraction: capitalize words that look like proper nouns
  // or are preceded by "Mi" / "mi" / "de" / "del".
  const matches = text.match(/(?:Mi|mi|de|del)\s+([A-Z][a-zA-Záéíóúñ]+(?:\s+[A-Z][a-zA-Záéíóúñ]+)?)/g) || [];
  const entities = matches
    .map((m) => m.replace(/^(Mi|mi|de|del)\s+/, "").trim())
    .filter((e) => e.length > 2);
  return Array.from(new Set(entities));
}

export async function fetchMemoryContext(text, project) {
  const result = {
    diaryEntries: [],
    kgFacts: [],
    semanticResults: [],
  };

  try {
    const diary = await diaryRead(AGENT_NAME, 5, JARVIS_WING);
    result.diaryEntries = (diary && diary.entries) || [];
  } catch (err) {
    console.error("fetchMemoryContext: diary read failed:", err.message);
  }

  try {
    const entities = extractEntities(text);
    if (entities.length > 0) {
      const kgResults = await Promise.all(
        entities.slice(0, 3).map((entity) =>
          kgQuery(entity, { direction: "both" }).catch(() => null)
        )
      );
      for (const r of kgResults) {
        if (r && Array.isArray(r.facts)) {
          result.kgFacts.push(...r.facts);
        }
      }
    }
  } catch (err) {
    console.error("fetchMemoryContext: kg query failed:", err.message);
  }

  try {
    const searchResult = await search(text, { limit: 3, wing: JARVIS_WING });
    result.semanticResults = (searchResult && searchResult.results) || [];
  } catch (err) {
    console.error("fetchMemoryContext: semantic search failed:", err.message);
  }

  return result;
}
