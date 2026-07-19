import { writeFile, mkdir, readFile } from "fs/promises";
import path from "path";
import { CONFIG } from "./config.js";
import {
  calendarList,
  gmailSearch,
  tasksList,
  metricsList,
  metricsQuery,
} from "./tools/mcp-helpers.js";
import { diaryRead } from "./tools/mempalace-mcp.js";

function getLimaDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: CONFIG.dailyLog.timezone }));
}

function formatLimaDate(date) {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: CONFIG.dailyLog.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatLimaTime(date) {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: CONFIG.dailyLog.timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function dateRangeForDay(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

async function fetchCalendarEvents(date) {
  try {
    const { start, end } = dateRangeForDay(date);
    const result = await calendarList({
      time_min: start.toISOString(),
      time_max: end.toISOString(),
      max_results: 50,
    });
    return (result && result.events) || [];
  } catch (err) {
    console.error("dailyLog: calendar fetch failed:", err.message);
    return [];
  }
}

async function fetchActionableEmails(date) {
  try {
    const dateStr = date.toISOString().slice(0, 10);
    const query = `is:inbox after:${dateStr}`;
    const result = await gmailSearch(query, 30);
    return (result && result.messages) || [];
  } catch (err) {
    console.error("dailyLog: gmail fetch failed:", err.message);
    return [];
  }
}

async function fetchTasks() {
  try {
    const result = await tasksList(50);
    return (result && result.tasks) || [];
  } catch (err) {
    console.error("dailyLog: tasks fetch failed:", err.message);
    return [];
  }
}

async function fetchMetrics(date) {
  try {
    const list = await metricsList();
    const metrics = (list && list.metrics) || [];
    const dateStr = date.toISOString().slice(0, 10);

    const results = [];
    for (const m of metrics.slice(0, 20)) {
      try {
        const data = await metricsQuery(m.domain, m.metric_name, 5);
        if (data && Array.isArray(data.records)) {
          const todayRecords = data.records.filter((r) =>
            r.timestamp && r.timestamp.startsWith(dateStr)
          );
          if (todayRecords.length > 0) {
            results.push({ ...m, records: todayRecords });
          }
        }
      } catch (err) {
        // Ignore per-metric errors.
      }
    }
    return results;
  } catch (err) {
    console.error("dailyLog: metrics fetch failed:", err.message);
    return [];
  }
}

async function fetchDiaryEntries(date) {
  try {
    const result = await diaryRead(CONFIG.memory.agentName, 20, CONFIG.memory.wing);
    if (!result || !Array.isArray(result.entries)) return [];
    const dateStr = date.toISOString().slice(0, 10);
    return result.entries.filter((e) => e.timestamp && e.timestamp.startsWith(dateStr));
  } catch (err) {
    console.error("dailyLog: diary fetch failed:", err.message);
    return [];
  }
}

function formatSection(title, lines) {
  if (!lines || lines.length === 0) return "";
  return [`## ${title}`, "", ...lines, ""].join("\n");
}

function buildDailyLog({ date, events, emails, tasks, metrics, diaryEntries }) {
  const dateStr = formatLimaDate(date);
  const parts = [`# Daily log — ${dateStr}`, ""];

  // Calendar
  const eventLines = events.map((e) => {
    const start = e.start ? new Date(e.start.dateTime || e.start.date) : null;
    const time = start ? formatLimaTime(start) : "todo el día";
    return `- ${time}: ${e.summary || "(sin título)"}${e.calendarName ? ` [${e.calendarName}]` : ""}`;
  });
  parts.push(formatSection("Calendario", eventLines));

  // Emails
  const emailLines = emails.map((m) => {
    const from = m.from ? m.from.split("<")[0].trim() : "(desconocido)";
    const flags = [];
    if (m.isUnread) flags.push("no leído");
    return `- ${from}: ${m.subject || "(sin asunto)"}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  parts.push(formatSection("Correos del día", emailLines));

  // Tasks
  const taskLines = tasks
    .filter((t) => !t.completed)
    .slice(0, 15)
    .map((t) => `- ${t.title}${t.due ? ` (vence: ${t.due.slice(0, 10)})` : ""}`);
  parts.push(formatSection("Pendientes activos", taskLines));

  // Metrics
  const metricLines = metrics.flatMap((m) =>
    m.records.map((r) => `- ${m.domain}/${m.metric_name}: ${r.value} ${r.unit || ""}`)
  );
  parts.push(formatSection("Métricas registradas", metricLines));

  // Diary
  const diaryLines = diaryEntries.map((e) => `- ${e.topic || "general"}: ${e.entry || e.content || ""}`.slice(0, 300));
  parts.push(formatSection("Momentos del día (diario del agente)", diaryLines));

  parts.push(`## Resumen TL;DR`, "", "_Pendiente de generar por el usuario o con /summarize-day._", "");
  parts.push(`Generado a las ${formatLimaTime(new Date())} — Lima`);

  return parts.join("\n").trim() + "\n";
}

export async function generateDailyLog(date = getLimaDate()) {
  const [events, emails, tasks, metrics, diaryEntries] = await Promise.all([
    fetchCalendarEvents(date),
    fetchActionableEmails(date),
    fetchTasks(),
    fetchMetrics(date),
    fetchDiaryEntries(date),
  ]);

  const content = buildDailyLog({ date, events, emails, tasks, metrics, diaryEntries });
  const filename = `${date.toISOString().slice(0, 10)}.md`;
  const filePath = path.join(CONFIG.dailyLog.draftPath, filename);

  await mkdir(CONFIG.dailyLog.draftPath, { recursive: true });
  await writeFile(filePath, content);

  return { filePath, content, events: events.length, emails: emails.length, tasks: tasks.length };
}

export function shouldGenerateDailyLog() {
  const now = getLimaDate();
  return (
    now.getHours() === CONFIG.dailyLog.hour &&
    now.getMinutes() === CONFIG.dailyLog.minute
  );
}
