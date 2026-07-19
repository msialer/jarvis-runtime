import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { askKimi } from "./kimi-bridge.js";
import { sendWhatsAppMessage } from "./baileys.js";
import { searchMemPalace } from "./tools/mempalace.js";
import { resolveProjectDir } from "./projects.js";
import { listProjects } from "./projects.js";

const EVENTS_FILE = "/home/ubuntu/projects/jarvis/data/events.json";

let state = null;

async function loadState() {
  if (state) return state;
  try {
    const raw = await readFile(EVENTS_FILE, "utf8");
    state = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      state = { events: [], version: 1 };
    } else {
      throw err;
    }
  }
  return state;
}

async function saveState() {
  await mkdir(path.dirname(EVENTS_FILE), { recursive: true });
  await writeFile(EVENTS_FILE, JSON.stringify(state, null, 2));
}

export async function listEvents() {
  await loadState();
  return state.events
    .filter((e) => e.enabled)
    .sort((a, b) => new Date(a.triggerAt) - new Date(b.triggerAt));
}

export async function addEvent(event) {
  await loadState();
  const newEvent = {
    id: randomUUID(),
    enabled: true,
    createdAt: new Date().toISOString(),
    ...event,
  };
  state.events.push(newEvent);
  await saveState();
  return newEvent;
}

export async function cancelEvent(id) {
  await loadState();
  const event = state.events.find((e) => e.id === id);
  if (!event) return null;
  event.enabled = false;
  await saveState();
  return event;
}

function computeNextTrigger(event) {
  const current = new Date(event.triggerAt);
  switch (event.recurrence) {
    case "daily":
      current.setDate(current.getDate() + 1);
      break;
    case "weekly":
      current.setDate(current.getDate() + 7);
      break;
    default:
      return null;
  }
  return current.toISOString();
}

async function triggerEvent(sock, event) {
  const projectDir = resolveProjectDir(event.project);
  const availableProjects = await listProjects();
  const palace = await searchMemPalace(event.prompt, 3);

  const context = {
    projectDir,
    project: event.project || "default",
    availableProjects,
    summary: "",
    sender: event.to,
    chat: event.to,
    isOwner: true,
    isGroup: event.to.endsWith("@g.us"),
    memPalaceResults: palace.results || [],
  };

  const prompt =
    `Eres el asistente ejecutivo personal de Mauricio dentro del proyecto JARVIS. ` +
    `Se ha disparado un evento programado de tipo "${event.type}". ` +
    `Genera un mensaje breve, útil y directo para enviar por WhatsApp. ` +
    `Usa TL;DR cuando optimice. No uses emojis. No contactes a terceros. ` +
    `No ejecutes acciones irreversibles.\n\n` +
    `Contexto del evento: ${event.prompt}`;

  const response = await askKimi(prompt, context);
  const text = response.error
    ? `Evento programado: ${event.prompt}`
    : response.answer;

  await sendWhatsAppMessage(sock, event.to, text);
}

async function checkAndTriggerEvents(sock) {
  await loadState();
  const now = new Date().toISOString();
  const dueEvents = state.events.filter(
    (e) => e.enabled && e.triggerAt <= now
  );

  for (const event of dueEvents) {
    try {
      await triggerEvent(sock, event);
      if (event.recurrence) {
        const next = computeNextTrigger(event);
        if (next) {
          event.triggerAt = next;
        } else {
          event.enabled = false;
        }
      } else {
        event.enabled = false;
      }
      await saveState();
    } catch (err) {
      console.error("Failed to trigger event:", event.id, err);
    }
  }
}

export async function startScheduler(sock) {
  while (true) {
    await new Promise((r) => setTimeout(r, 60000));
    try {
      await checkAndTriggerEvents(sock);
    } catch (err) {
      console.error("Scheduler loop error:", err);
    }
  }
}
