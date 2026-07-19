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
};
