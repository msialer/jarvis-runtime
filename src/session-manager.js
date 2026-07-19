import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const SESSIONS_FILE = "/home/ubuntu/projects/jarvis/data/sessions.json";
const COMPACTION_THRESHOLD = 5;
const MAX_RECENT_MESSAGES = 20;

let state = null;

async function loadState() {
  if (state) return state;
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    state = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      state = { chats: {}, version: 1 };
    } else {
      throw err;
    }
  }
  return state;
}

async function saveState() {
  await mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(state, null, 2));
}

function getChatState(chatJid) {
  if (!state.chats[chatJid]) {
    state.chats[chatJid] = {
      activeProject: "default",
      projects: {},
      recentMessages: [],
      conversationState: {
        currentTopic: "",
        pendingAction: "",
        sharedFacts: {},
        lastIntent: "",
      },
    };
  }
  // Backfill for chat states created before this change.
  if (!state.chats[chatJid].recentMessages) {
    state.chats[chatJid].recentMessages = [];
  }
  if (!state.chats[chatJid].conversationState) {
    state.chats[chatJid].conversationState = {
      currentTopic: "",
      pendingAction: "",
      sharedFacts: {},
      lastIntent: "",
    };
  }
  return state.chats[chatJid];
}

function getProjectState(chatState, projectKey) {
  if (!chatState.projects[projectKey]) {
    chatState.projects[projectKey] = {
      lastActivity: null,
      messageCount: 0,
      summary: "",
      lcmConversationId: null,
    };
  }
  // Backfill for project states created before LCM.
  if (chatState.projects[projectKey].lcmConversationId === undefined) {
    chatState.projects[projectKey].lcmConversationId = null;
  }
  return chatState.projects[projectKey];
}

export async function getActiveProject(chatJid) {
  await loadState();
  return getChatState(chatJid).activeProject;
}

export async function setActiveProject(chatJid, projectKey) {
  await loadState();
  getChatState(chatJid).activeProject = projectKey;
  await saveState();
}

export async function getSession(chatJid, projectKey) {
  await loadState();
  const chatState = getChatState(chatJid);
  const key = projectKey || chatState.activeProject;
  return getProjectState(chatState, key);
}

export async function updateSession(chatJid, projectKey, patch) {
  await loadState();
  const chatState = getChatState(chatJid);
  const key = projectKey || chatState.activeProject;
  const projectState = getProjectState(chatState, key);
  Object.assign(projectState, patch);
  projectState.lastActivity = new Date().toISOString();
  await saveState();
}

export async function resetSession(chatJid, projectKey) {
  await loadState();
  const chatState = getChatState(chatJid);
  const key = projectKey || chatState.activeProject;
  chatState.projects[key] = {
    lastActivity: null,
    messageCount: 0,
    summary: "",
  };
  await saveState();
}

export async function bumpMessageCount(chatJid, projectKey) {
  await loadState();
  const chatState = getChatState(chatJid);
  const key = projectKey || chatState.activeProject;
  const projectState = getProjectState(chatState, key);
  projectState.messageCount += 1;
  projectState.lastActivity = new Date().toISOString();
  await saveState();
  return projectState.messageCount;
}

export async function shouldCompact(chatJid, projectKey) {
  const session = await getSession(chatJid, projectKey);
  return session.messageCount >= COMPACTION_THRESHOLD;
}

export async function applyCompaction(chatJid, projectKey, summary) {
  await loadState();
  const chatState = getChatState(chatJid);
  const key = projectKey || chatState.activeProject;
  const projectState = getProjectState(chatState, key);
  projectState.summary = summary || "";
  projectState.messageCount = 0;
  await saveState();
}

export async function getSummary(chatJid, projectKey) {
  const session = await getSession(chatJid, projectKey);
  return session.summary || "";
}

export async function listProjectSessions(chatJid) {
  await loadState();
  const chatState = getChatState(chatJid);
  return Object.entries(chatState.projects).map(([key, s]) => ({
    key,
    lastActivity: s.lastActivity,
    messageCount: s.messageCount,
    hasSummary: !!s.summary,
    active: key === chatState.activeProject,
  }));
}

export async function addRecentMessage(chatJid, entry) {
  await loadState();
  const chatState = getChatState(chatJid);
  chatState.recentMessages.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (chatState.recentMessages.length > MAX_RECENT_MESSAGES) {
    chatState.recentMessages = chatState.recentMessages.slice(-MAX_RECENT_MESSAGES);
  }
  await saveState();
}

export async function getRecentMessages(chatJid, limit = 10) {
  await loadState();
  const chatState = getChatState(chatJid);
  return chatState.recentMessages.slice(-limit);
}

export async function updateConversationState(chatJid, patch) {
  await loadState();
  const chatState = getChatState(chatJid);
  chatState.conversationState = {
    ...chatState.conversationState,
    ...patch,
    sharedFacts: {
      ...chatState.conversationState.sharedFacts,
      ...(patch.sharedFacts || {}),
    },
  };
  await saveState();
}

export async function getConversationState(chatJid) {
  await loadState();
  return getChatState(chatJid).conversationState;
}

export async function clearPendingAction(chatJid) {
  await loadState();
  const chatState = getChatState(chatJid);
  chatState.conversationState.pendingAction = "";
  await saveState();
}
