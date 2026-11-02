// Renders the demo video from the recording console (demo/index.html):
// narration with an offline Windows voice, frames captured from headless Chrome at
// 1920x1080, assembled with ffmpeg. Output: video/arkhe-guard-demo.mp4
//
// Requires: Chrome, ffmpeg/ffprobe on PATH, Windows PowerShell (SAPI voice). Run: npm run render
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const HERE = import.meta.dirname;
const DEMO = resolve(HERE, "..", "demo");
const BUILD = join(HERE, "build");
const OUT = join(HERE, "arkhe-guard-demo.mp4");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FPS = 30;
const ANIMATION_WINDOW_MS = 3200; // frames are captured live for this long; the rest of a scene holds
const PAD_BEFORE = 0.35, PAD_AFTER = 0.7; // seconds of silence around each narration line
const MIN_SCENE = 3.5;

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(join(BUILD, "frames"), { recursive: true });

// 1. Serve the console over HTTP so fonts, scripts and the live RPC read behave as in Chrome.
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const path = join(DEMO, pathname === "/" ? "index.html" : pathname);
  if (!path.startsWith(DEMO)) { res.writeHead(403).end(); return; }
  let body;
  try { body = readFileSync(path); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
}).listen(0, "127.0.0.1");
await new Promise(r => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/?record`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--window-size=1920,1080", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);

// 2. Narration: one line per console step, taken from the console's own captions.
const captions = await page.evaluate(() => steps.map(s => s.caption));
writeFileSync(join(BUILD, "captions.json"), JSON.stringify(captions, null, 2));
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "tts.ps1"), "-Build", BUILD], { stdio: "inherit" });
const durationOf = file => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
const speech = captions.map((_, i) => durationOf(join(BUILD, "audio", `${String(i).padStart(2, "0")}.wav`)));
const scene = speech.map(s => Math.max(MIN_SCENE, PAD_BEFORE + s + PAD_AFTER));

// 3. Frames: advance one step, capture live while animations run, then hold the last frame.
const concat = [];
let frameNo = 0;
const shoot = async () => {
  const file = join(BUILD, "frames", `${String(frameNo++).padStart(5, "0")}.png`);
  await page.screenshot({ path: file, type: "png" });
  return file;
};
for (let i = 0; i < captions.length; i++) {
  if (i > 0) await page.keyboard.press("ArrowRight");
  const scenePromise = (async () => {
    if (await page.evaluate(() => steps[step].scene) === "evidence") {
      await new Promise(r => setTimeout(r, 900));
      await page.keyboard.press("l"); // live, read-only testnet query
    }
  })();
  const start = Date.now();
  let last = null, lastAt = 0;
  const window = Math.min(ANIMATION_WINDOW_MS, scene[i] * 1000);
  while (Date.now() - start < window) {
    const at = (Date.now() - start) / 1000;
    if (last) concat.push(`file '${last.replaceAll("\\", "/")}'\nduration ${(at - lastAt).toFixed(3)}`);
    last = await shoot(); lastAt = at;
  }
  await scenePromise;
  await new Promise(r => setTimeout(r, 250));
  if (last) concat.push(`file '${last.replaceAll("\\", "/")}'\nduration ${(window / 1000 - lastAt).toFixed(3)}`);
  const hold = await shoot();
  concat.push(`file '${hold.replaceAll("\\", "/")}'\nduration ${Math.max(0.04, scene[i] - window / 1000).toFixed(3)}`);
  console.log(`scene ${i}: ${scene[i].toFixed(2)} s, speech ${speech[i].toFixed(2)} s`);
}
// The concat demuxer needs the last file repeated to honour its duration.
concat.push(concat.at(-1).split("\n")[0]);
writeFileSync(join(BUILD, "frames.txt"), "ffconcat version 1.0\n" + concat.join("\n") + "\n");
const liveMatch = await page.evaluate(() => document.getElementById("match").textContent);
await browser.close();
server.close();

// 4. Audio track: each line delayed by PAD_BEFORE and padded to its scene length.
const audioInputs = captions.flatMap((_, i) => ["-i", join(BUILD, "audio", `${String(i).padStart(2, "0")}.wav`)]);
const filters = scene.map((d, i) => `[${i}:a]adelay=${Math.round(PAD_BEFORE * 1000)}:all=1,apad,atrim=0:${d.toFixed(3)}[a${i}]`);
const filter = filters.join(";") + ";" + scene.map((_, i) => `[a${i}]`).join("") + `concat=n=${scene.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
execFileSync("ffmpeg", ["-y", "-v", "error", ...audioInputs, "-filter_complex", filter, "-map", "[out]", "-ar", "48000", join(BUILD, "narration.wav")], { stdio: "inherit" });

// 5. Video: constant 30 fps, short fades, H.264 + AAC, web-ready.
const total = scene.reduce((a, b) => a + b, 0);
execFileSync("ffmpeg", ["-y", "-v", "error",
  "-f", "concat", "-safe", "0", "-i", join(BUILD, "frames.txt"),
  "-i", join(BUILD, "narration.wav"),
  "-vf", `fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8`,
  "-af", `afade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8`,
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "160k",
  "-movflags", "+faststart", "-shortest", OUT], { stdio: "inherit" });

console.log(`\n${OUT}\nduration ${total.toFixed(1)} s, ${frameNo} captured frames, live check: ${liveMatch}`);
