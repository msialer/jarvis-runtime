import { readdir, stat } from "fs/promises";
import path from "path";

const PROJECTS_ROOT = "/home/ubuntu/projects/jarvis/projects";
const DEFAULT_PROJECT = "default";

export async function listProjects() {
  const entries = await readdir(PROJECTS_ROOT);
  const projects = [];
  for (const entry of entries) {
    const fullPath = path.join(PROJECTS_ROOT, entry);
    const st = await stat(fullPath);
    if (st.isDirectory()) {
      const kimiPath = path.join(fullPath, "KIMI.md");
      try {
        await stat(kimiPath);
        projects.push(entry);
      } catch {
        // Directory without KIMI.md is not a valid project.
      }
    }
  }
  return projects.sort();
}

export function resolveProjectDir(projectKey) {
  if (!projectKey) projectKey = DEFAULT_PROJECT;
  return path.join(PROJECTS_ROOT, projectKey);
}

export function isValidProject(projectKey) {
  if (!projectKey) return false;
  const valid = /^[a-z0-9_-]+$/i;
  return valid.test(projectKey);
}

export async function projectExists(projectKey) {
  if (!isValidProject(projectKey)) return false;
  try {
    await stat(path.join(PROJECTS_ROOT, projectKey, "KIMI.md"));
    return true;
  } catch {
    return false;
  }
}

export function getDefaultProject() {
  return DEFAULT_PROJECT;
}
