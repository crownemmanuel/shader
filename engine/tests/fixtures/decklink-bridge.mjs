// Process-boundary fixture, not a hardware simulator or a native SDK test.
import fs from "node:fs";
import path from "node:path";
const file = process.argv[2];
const root = path.dirname(file);
const log = path.join(root, "events.jsonl");
let config = JSON.parse(fs.readFileSync(file, "utf8"));
if (process.argv[3] === "--list") {
  if (config.invalid) process.stdout.write(config.invalid);
  else console.log(JSON.stringify(config.list));
  process.exit(config.list?.error ? 1 : 0);
}
const device = process.argv[4];
const lock = path.join(root, encodeURIComponent(device) + ".lock");
function event(data) { fs.appendFileSync(log, JSON.stringify({ ...data, device, pid: process.pid }) + "\n"); }
function status(data) { process.stderr.write(JSON.stringify(data) + "\n"); }
if (config.error) { status({ event: "error", code: config.error }); process.exit(1); }
try { fs.closeSync(fs.openSync(lock, "wx")); }
catch { status({ event: "error", code: "input_busy" }); process.exit(1); }
event({ event: "start", args: process.argv.slice(3) });
let n = 0, previous, stopping = false;
const timer = setInterval(() => {
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const signal = config.noSignal ? "no_signal" : "live";
  if (signal !== previous) { status({ event: "status", status: signal }); previous = signal; }
  if (!config.noSignal && !config.silent)
    process.stdout.write(Buffer.from([255, 216, 11, (++n % 200) + 1, 12, 255, 217]));
}, 30);
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  setTimeout(() => {
    fs.rmSync(lock, { force: true });
    event({ event: "stop" });
    process.exit(0);
  }, 60);
}
process.stdin.resume();
process.stdin.on("end", stop);
process.stdin.on("data", (b) => { if (b.toString().includes("stop")) stop(); });
process.on("SIGTERM", stop);
