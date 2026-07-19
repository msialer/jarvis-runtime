export const CONFIG = {
  // WhatsApp settings
  whatsapp: {
    // Phone numbers that are "me" (owner). Used to identify commands from owner.
    // Both personal and work numbers are treated as Mauricio.
    ownerNumbers: [
      "51991024114@s.whatsapp.net",
      "51982131101@s.whatsapp.net",
    ],
    // Home group chat for proactive briefs/alerts.
    homeGroup: "120363424471921890@g.us",
    // Allowed chat JIDs (individuals or groups). Empty array = allow all from owners.
    whitelist: [],
    // Session file path
    sessionPath: "/home/ubuntu/projects/jarvis/runtime/sessions",
  },

  // Kimi Code CLI settings
  kimi: {
    binary: "/home/ubuntu/.kimi-code/bin/kimi",
    projectDir: "/home/ubuntu/projects/jarvis",
    timeoutMs: 120000,
  },

  // MemPalace settings
  mempalace: {
    palacePath: "/home/ubuntu/.mempalace/palace",
    binary: "/home/ubuntu/.local/bin/mempalace",
  },

  // Metrics database
  metrics: {
    script: "/home/ubuntu/projects/jarvis/tools/metrics_db.py",
  },

  // Proactive checks (in minutes)
  proactive: {
    morningBriefHour: 6,
    morningBriefMinute: 0,
    inboxCheckIntervalMinutes: 60,
  },

  // MCP servers available to the runtime (subset of .kimi-code/mcp.json).
  mcpServers: {
    mempalace: {
      command: "/home/ubuntu/.local/bin/mempalace-mcp",
      args: ["--palace", "/home/ubuntu/.mempalace/palace", "--transport", "stdio"],
    },
    metrics: {
      command: "/home/ubuntu/projects/jarvis/.venv/bin/python",
      args: ["/home/ubuntu/projects/jarvis/tools/metrics_mcp.py"],
    },
    obsidian_reader: {
      command: "/home/ubuntu/projects/jarvis/.venv/bin/python",
      args: ["/home/ubuntu/projects/jarvis/tools/obsidian_reader_mcp.py"],
      env: {
        OBSIDIAN_VAULT_PATH: "/home/ubuntu/obsidian-vault",
        JARVIS_INDEX_DB: "/home/ubuntu/projects/jarvis/data/jarvis_index.db",
      },
    },
    gmail: {
      command: "/home/ubuntu/projects/jarvis/.venv/bin/python",
      args: ["/home/ubuntu/projects/jarvis/tools/gmail_mcp.py"],
      env: {
        GMAIL_TOKEN_PATH: "/home/ubuntu/projects/jarvis/data/credentials/gmail-token.json",
      },
    },
    calendar: {
      command: "/home/ubuntu/projects/jarvis/.venv/bin/python",
      args: ["/home/ubuntu/projects/jarvis/tools/calendar_mcp.py"],
      env: {
        CALENDAR_TOKEN_PATH: "/home/ubuntu/projects/jarvis/data/credentials/calendar-token.json",
      },
    },
    tasks: {
      command: "/home/ubuntu/projects/jarvis/.venv/bin/python",
      args: ["/home/ubuntu/projects/jarvis/tools/tasks_mcp.py"],
      env: {
        TASKS_TOKEN_PATH: "/home/ubuntu/projects/jarvis/data/credentials/tasks-token.json",
      },
    },
  },

  // Memory / continuity settings
  memory: {
    // Wing and room used for conversation checkpoints.
    wing: "jarvis",
    room: "conversations",
    // Agent name for MemPalace diary entries.
    agentName: "jarvis",
    // Max length of conversation snippet persisted per turn.
    maxSnippetLength: 800,
    // Dedup threshold for checkpoint items (0-1).
    checkpointDedupThreshold: 0.92,
  },

  // Handoff settings
  handoff: {
    filePath: "/home/ubuntu/projects/jarvis/vault/memory/CURRENT_STATE.md",
  },

  // Daily log settings
  dailyLog: {
    enabled: true,
    hour: 23,
    minute: 30,
    timezone: "America/Lima",
    draftPath: "/home/ubuntu/projects/jarvis/vault/daily",
  },

  // User modeling settings
  userModel: {
    enabled: true,
    // Number of owner turns before proposing a USER.md update.
    turnThreshold: 20,
    filePath: "/home/ubuntu/projects/jarvis/vault/memory/semantic/USER.md",
    // If true, non-sensitive facts already verified can be applied without approval.
    autoApplyMinor: false,
  },
};
