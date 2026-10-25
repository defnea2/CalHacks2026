// Spike (kept for reference): headless Chrome plays a WAV as the microphone only with
// --no-sandbox on macOS; the file loops when it ends. Prints input level every 250 ms.
import puppeteer from 'puppeteer-core';
import path from 'node:path';

const wav = path.resolve(import.meta.dirname, '../fixtures/correct-step.wav');
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8787/health'); // any localhost page: getUserMedia needs a secure context
const levels = await page.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 2048;
  ac.createMediaStreamSource(s).connect(an);
  const buf = new Float32Array(2048);
  const out: string[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 9000) {
    await new Promise(r => setTimeout(r, 250));
    an.getFloatTimeDomainData(buf);
    let e = 0;
    for (const v of buf) e += v * v;
    out.push((10 * Math.log10(e / buf.length + 1e-12)).toFixed(0));
  }
  return out.join(' ');
});
console.log(levels);
await browser.close();
