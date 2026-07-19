import qrcode from "qrcode-terminal";
import { readFile, stat } from "fs/promises";
import { watch } from "fs";

const QR_FILE = "/tmp/jarvis-qr-latest.txt";

async function render() {
  try {
    const qr = await readFile(QR_FILE, "utf8");
    if (!qr.trim()) return;
    console.clear();
    console.log("\n=== ESCANEA ESTE QR CON WHATSAPP ===\n");
    qrcode.generate(qr.trim(), { small: true });
    console.log("\nSe regenera automáticamente si expira. Ctrl+C para salir.");
  } catch (err) {
    console.clear();
    console.log("Esperando QR...");
  }
}

await render();

// Re-render when the file changes.
const watcher = watch(QR_FILE, async () => {
  await render();
});

// Also re-render periodically in case the file content changes without a rename event.
setInterval(render, 3000);

process.on("SIGINT", () => {
  watcher.close();
  process.exit(0);
});
