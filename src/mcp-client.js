import { spawn } from "child_process";
import { EventEmitter } from "events";

const DEFAULT_TIMEOUT_MS = 30000;
const PENDING = new Map();
let requestIdCounter = 1;

class McpServerConnection extends EventEmitter {
  constructor(name, config) {
    super();
    this.name = name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.process = null;
    this.buffer = "";
    this.ready = false;
    this.closed = false;
    this.tools = null;
  }

  async start() {
    if (this.process) return;
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.env };
      this.process = spawn(this.command, this.args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.stdout.on("data", (chunk) => this._onData(chunk));
      this.process.stderr.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) console.error(`[MCP ${this.name} stderr]`, line);
      });

      this.process.on("error", (err) => {
        this.closed = true;
        reject(new Error(`MCP server ${this.name} failed to start: ${err.message}`));
      });

      this.process.on("exit", (code) => {
        this.closed = true;
        this.ready = false;
        this.process = null;
        this.emit("exit", code);
      });

      // Give the server a moment to print startup banner and initialize.
      setTimeout(() => {
        this.ready = true;
        resolve();
      }, 500);
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch {
        // Non-JSON lines (startup banners) are ignored.
        console.log(`[MCP ${this.name}]`, line);
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && PENDING.has(msg.id)) {
      const { resolve, reject } = PENDING.get(msg.id);
      PENDING.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  async callTool(toolName, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.process || this.closed) {
      await this.start();
    }
    const id = requestIdCounter++;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args || {},
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        PENDING.delete(id);
        reject(new Error(`MCP tool ${toolName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      PENDING.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.process.stdin.write(JSON.stringify(request) + "\n");
      } catch (err) {
        clearTimeout(timer);
        PENDING.delete(id);
        reject(err);
      }
    });
  }

  async listTools(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.tools) return this.tools;
    if (!this.process || this.closed) {
      await this.start();
    }
    const id = requestIdCounter++;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tools/list",
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        PENDING.delete(id);
        reject(new Error(`MCP tools/list timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      PENDING.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          this.tools = (result && result.tools) || [];
          resolve(this.tools);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.process.stdin.write(JSON.stringify(request) + "\n");
      } catch (err) {
        clearTimeout(timer);
        PENDING.delete(id);
        reject(err);
      }
    });
  }

  async stop() {
    this.closed = true;
    if (this.process) {
      this.process.stdin.end();
      this.process.kill();
      this.process = null;
    }
  }

  async restart() {
    await this.stop();
    this.closed = false;
    this.tools = null;
    await this.start();
  }
}

const connections = new Map();

export async function getMcpServer(name, config) {
  if (!connections.has(name)) {
    const conn = new McpServerConnection(name, config);
    connections.set(name, conn);
    await conn.start();
  }
  return connections.get(name);
}

export async function callMcpTool(serverName, config, toolName, args, timeoutMs) {
  const server = await getMcpServer(serverName, config);
  return server.callTool(toolName, args, timeoutMs);
}

export async function listMcpTools(serverName, config, timeoutMs) {
  const server = await getMcpServer(serverName, config);
  return server.listTools(timeoutMs);
}

export async function closeAllMcpConnections() {
  for (const [name, conn] of connections.entries()) {
    try {
      await conn.stop();
    } catch (err) {
      console.error(`Failed to stop MCP server ${name}:`, err);
    }
  }
  connections.clear();
}

process.on("SIGTERM", closeAllMcpConnections);
process.on("SIGINT", closeAllMcpConnections);
