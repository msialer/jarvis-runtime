import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { mkdir, readdir, stat } from "fs/promises";

const execFileAsync = promisify(execFile);

export const SUPPORTED_ARCHIVE_MIMETYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
]);

export function isArchive(mimetype, filename = "") {
  if (SUPPORTED_ARCHIVE_MIMETYPES.has(mimetype)) return true;
  const ext = path.extname(filename).toLowerCase();
  const exts = new Set([
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".tbz2",
    ".xz",
    ".txz",
    ".rar",
    ".7z",
  ]);
  return exts.has(ext);
}

async function listDirectory(dir, baseDir = dir) {
  const result = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      result.push({ path: relativePath, type: "directory" });
      result.push(...(await listDirectory(fullPath, baseDir)));
    } else {
      const info = await stat(fullPath);
      result.push({
        path: relativePath,
        type: "file",
        size: info.size,
      });
    }
  }
  return result;
}

async function extractZip(filePath, outputDir) {
  await execFileAsync("unzip", ["-q", "-o", filePath, "-d", outputDir], { timeout: 60000 });
}

async function extractTar(filePath, outputDir) {
  await execFileAsync("tar", ["-xf", filePath, "-C", outputDir], { timeout: 60000 });
}

async function extractRar(filePath, outputDir) {
  // unrar-free supports 'x' for extract with full path.
  await execFileAsync("unrar-free", ["x", "-o+", filePath, outputDir], { timeout: 60000 });
}

async function extract7z(filePath, outputDir) {
  await execFileAsync("7z", ["x", filePath, `-o${outputDir}`, "-y"], { timeout: 60000 });
}

function detectArchiveType(filePath, mimetype) {
  const fullExt = filePath.toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  const lowerMimetype = (mimetype || "").toLowerCase();

  const isZip = ext === ".zip" || lowerMimetype === "application/zip" || lowerMimetype === "application/x-zip-compressed";
  const isRar = ext === ".rar" || lowerMimetype === "application/vnd.rar" || lowerMimetype === "application/x-rar-compressed";
  const is7z = ext === ".7z" || lowerMimetype === "application/x-7z-compressed";
  const isTar =
    ext === ".tar" ||
    [".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz"].some((e) => fullExt.endsWith(e)) ||
    lowerMimetype === "application/x-tar" ||
    lowerMimetype === "application/gzip" ||
    lowerMimetype === "application/x-gzip" ||
    lowerMimetype === "application/x-bzip2" ||
    lowerMimetype === "application/x-xz";

  if (isZip) return "zip";
  if (isRar) return "rar";
  if (is7z) return "7z";
  if (isTar) return "tar";
  return null;
}

export async function extractArchive(filePath, mimetype, outputBaseDir) {
  const type = detectArchiveType(filePath, mimetype);
  if (!type) {
    throw new Error(`No se pudo detectar el tipo de archivo comprimido: ${mimetype}`);
  }

  const basename = path.basename(filePath, path.extname(filePath));
  const outputDir = path.join(outputBaseDir, `${basename}-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });

  switch (type) {
    case "zip":
      await extractZip(filePath, outputDir);
      break;
    case "tar":
      await extractTar(filePath, outputDir);
      break;
    case "rar":
      await extractRar(filePath, outputDir);
      break;
    case "7z":
      await extract7z(filePath, outputDir);
      break;
    default:
      throw new Error(`Tipo de archivo comprimido no soportado: ${type}`);
  }

  const files = await listDirectory(outputDir);
  return {
    extractedPath: outputDir,
    files,
    type,
  };
}
