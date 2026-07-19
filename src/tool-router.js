import { readFile, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { load as yamlLoad } from "js-yaml";
import { minimatch } from "minimatch";
import { CONFIG } from "./config.js";

const POLICY_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tool-policies.yaml"
);

let cachedPolicies = null;
let cachedMtime = null;

async function loadPolicies() {
  const s = await stat(POLICY_FILE);
  if (cachedPolicies && cachedMtime === s.mtimeMs) {
    return cachedPolicies;
  }
  const raw = await readFile(POLICY_FILE, "utf8");
  const doc = yamlLoad(raw);
  cachedPolicies = doc.policies || [];
  cachedMtime = s.mtimeMs;
  return cachedPolicies;
}

function normalizeToolName(name) {
  if (!name) return "default";
  const lower = String(name).toLowerCase().trim();
  // Normalize MCP-style names like "gmail_read" or "google-calendar".
  return lower.replace(/[-_]+/g, "_");
}

function getPolicy(policies, toolName) {
  const normalized = normalizeToolName(toolName);
  const exact = policies.find((p) => normalizeToolName(p.tool) === normalized);
  if (exact) return exact;
  return policies.find((p) => normalizeToolName(p.tool) === "default");
}

export function parseToolArgs(args) {
  if (args === null || args === undefined) return {};
  if (typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args !== "string") return { raw: String(args) };
  const trimmed = args.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { command: trimmed };
    }
  }
  return { command: trimmed };
}

function matchesAny(value, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const str = String(value);
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(str);
    } catch {
      return str.includes(p);
    }
  });
}

function isPathAllowed(filePath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  // Resolve relative paths against the JARVIS project root so that
  // `vault/inbox/note.md` is treated as `~/projects/jarvis/vault/inbox/note.md`
  // even when the runtime runs from `~/projects/jarvis/runtime`.
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(CONFIG.kimi.projectDir, filePath);
  return patterns.some((pattern) => {
    const normalizedPattern = path.normalize(pattern);
    if (minimatch(absolute, normalizedPattern, { dot: true })) return true;
    // Allow directory prefix matches when pattern ends with **.
    if (normalizedPattern.endsWith("/**")) {
      const prefix = normalizedPattern.slice(0, -3);
      return absolute === prefix || absolute.startsWith(prefix + path.sep);
    }
    return false;
  });
}

function validateBashCommand(cmd, policy) {
  const str = String(cmd);

  // Denylist first.
  if (policy.denylist && matchesAny(str, policy.denylist)) {
    return {
      ok: false,
      reason: "comando coincide con la denylist de seguridad",
    };
  }

  // Allowlist.
  if (policy.allowlist && policy.allowlist.length > 0) {
    if (matchesAny(str, policy.allowlist)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "comando bash fuera de allowlist permitida",
    };
  }

  return { ok: true };
}

function validatePaths(parsedArgs, policy) {
  const paths = [];
  for (const key of ["file_path", "path", "target", "destination", "source"]) {
    if (parsedArgs[key]) paths.push(parsedArgs[key]);
  }

  if (paths.length === 0) return { ok: true };

  for (const p of paths) {
    if (!isPathAllowed(p, policy.restrict_paths)) {
      return {
        ok: false,
        reason: `path '${p}' fuera de los paths permitidos`,
      };
    }
  }
  return { ok: true };
}

export async function evaluateTool(toolName, args) {
  const policies = await loadPolicies();
  const policy = getPolicy(policies, toolName);
  const decision = policy?.default || "ask";

  const parsedArgs = parseToolArgs(args);

  // Path validation applies to read/write/edit and similar tools.
  const needsPathCheck = ["read", "write", "edit"].includes(
    normalizeToolName(toolName)
  );
  if (needsPathCheck && policy?.restrict_paths) {
    const pathCheck = validatePaths(parsedArgs, policy);
    if (!pathCheck.ok) {
      return { decision: "deny", reason: pathCheck.reason };
    }
  }

  // Bash validation.
  if (normalizeToolName(toolName) === "bash") {
    const cmd =
      parsedArgs.command ??
      parsedArgs.args ??
      parsedArgs.script ??
      (typeof args === "string" ? args : null);
    if (!cmd || String(cmd).trim().length === 0) {
      return { decision: "deny", reason: "comando bash vacío" };
    }
    const bashCheck = validateBashCommand(cmd, policy);
    if (!bashCheck.ok) {
      return { decision: "deny", reason: bashCheck.reason };
    }
  }

  return { decision, reason: `política default para ${toolName}: ${decision}` };
}

export function formatToolForDisplay(toolName, args) {
  const parsed = parseToolArgs(args);
  if (normalizeToolName(toolName) === "bash") {
    const cmd =
      parsed.command ??
      parsed.args ??
      parsed.script ??
      (typeof args === "string" ? args : JSON.stringify(args));
    return `bash: ${cmd}`;
  }
  return `${toolName}: ${JSON.stringify(parsed, null, 2)}`;
}
