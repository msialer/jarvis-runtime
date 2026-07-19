import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { mkdir, unlink } from "fs/promises";
import ffmpegStatic from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const WHISPER_DIR = "/home/ubuntu/projects/jarvis/tools/whisper.cpp";
const WHISPER_MODEL = path.join(WHISPER_DIR, "models", "ggml-base.bin");
const WHISPER_CLI = path.join(WHISPER_DIR, "build", "bin", "whisper-cli");
const TEMP_DIR = "/home/ubuntu/projects/jarvis/data/downloads/whatsapp/transcode";

async function ensureDirs() {
  await mkdir(TEMP_DIR, { recursive: true });
}

async function convertToWav(inputPath) {
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static binary not found");
  }

  await ensureDirs();
  const basename = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(TEMP_DIR, `${basename}-${Date.now()}.wav`);

  await execFileAsync(ffmpegStatic, [
    "-i", inputPath,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-y",
    wavPath,
  ]);

  return wavPath;
}

export async function transcribeAudio(inputPath, opts = {}) {
  const language = opts.language || "es";
  const wavPath = await convertToWav(inputPath);

  try {
    const { stdout, stderr } = await execFileAsync(
      WHISPER_CLI,
      [
        "-m", WHISPER_MODEL,
        "-f", wavPath,
        "-l", language,
        "-np",
        "--no-timestamps",
      ],
      { timeout: 120000 }
    );

    // whisper-cli prints transcription to stdout; stderr has progress info.
    const text = (stdout || "").trim();
    return {
      text,
      language,
      model: "ggml-base",
    };
  } finally {
    // Clean up the temporary WAV file.
    try {
      await unlink(wavPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}
