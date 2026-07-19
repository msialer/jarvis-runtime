import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import path from "path";
import { parseToolArgs } from "./tool-router.js";

const execFileAsync = promisify(execFile);
const AUDIT_FILE = "/home/ubuntu/projects/jarvis/data/tool-audit.ndjson";

async function audit(entry) {
  await mkdir(path.dirname(AUDIT_FILE), { recursive: true });
  await appendFile(AUDIT_FILE, JSON.stringify(entry) + "\n");
}

function shellParse(str) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (/\s/.test(c)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

async function executeBash(args, meta) {
  const parsed = parseToolArgs(args);
  const cmdStr =
    parsed.command ??
    parsed.args ??
    parsed.script ??
    (typeof args === "string" ? args : null);

  if (!cmdStr || String(cmdStr).trim().length === 0) {
    return { success: false, output: "", error: "comando bash vacío" };
  }

  const argv = shellParse(String(cmdStr));
  if (argv.length === 0) {
    return { success: false, output: "", error: "comando bash vacío" };
  }

  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: 60000,
      shell: false,
      env: { ...process.env, PATH: `${process.env.PATH}:/home/ubuntu/.local/bin` },
    });
    const result = { success: true, output: stdout || stderr || "(sin salida)" };
    await audit({ ...meta, result: "success", output: result.output });
    return result;
  } catch (err) {
    const result = {
      success: false,
      output: err.stdout || "",
      error: err.message,
    };
    await audit({ ...meta, result: "error", error: err.message });
    return result;
  }
}

async function executeRead(args, meta) {
  const parsed = parseToolArgs(args);
  const filePath = parsed.file_path ?? parsed.path ?? parsed.target;
  if (!filePath) {
    return { success: false, output: "", error: "falta file_path" };
  }
  try {
    const content = await readFile(filePath, "utf8");
    const output = content.length > 10000 ? content.slice(0, 10000) + "\n... (truncado)" : content;
    await audit({ ...meta, result: "success", output });
    return { success: true, output };
  } catch (err) {
    await audit({ ...meta, result: "error", error: err.message });
    return { success: false, output: "", error: err.message };
  }
}

async function executeWrite(args, meta) {
  const parsed = parseToolArgs(args);
  const filePath = parsed.file_path ?? parsed.path ?? parsed.target;
  const content = parsed.content ?? parsed.text ?? "";
  if (!filePath) {
    return { success: false, output: "", error: "falta file_path" };
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    await audit({ ...meta, result: "success", output: `escrito ${filePath}` });
    return { success: true, output: `Escrito en ${filePath}` };
  } catch (err) {
    await audit({ ...meta, result: "error", error: err.message });
    return { success: false, output: "", error: err.message };
  }
}

export async function executeTool(toolName, args, meta = {}) {
  const normalized = String(toolName).toLowerCase().trim().replace(/[-_]+/g, "_");
  const auditMeta = {
    timestamp: new Date().toISOString(),
    tool: normalized,
    args: typeof args === "string" ? args : JSON.stringify(args),
    ...meta,
  };

  switch (normalized) {
    case "bash":
      return executeBash(args, auditMeta);
    case "read":
      return executeRead(args, auditMeta);
    case "write":
      return executeWrite(args, auditMeta);
    case "edit":
      await audit({ ...auditMeta, result: "error", error: "tool edit no soportada aún" });
      return {
        success: false,
        output: "",
        error: "La tool 'edit' aún no está soportada. Usá write o pedime que lo implemente.",
      };
    default:
      await audit({
        ...auditMeta,
        result: "error",
        error: `tool '${toolName}' no soportada por el executor nativo`,
      });
      return {
        success: false,
        output: "",
        error: `Tool '${toolName}' no soportada por el executor nativo. Configure MCP o implementa la tool.`,
      };
  }
}
