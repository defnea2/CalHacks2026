// ?miccheck: runs AudioCapture + VAD locally without a session and without sending anything.
// For checking microphone, noise floor and VAD timings (also used to smoke-test the VAD
// assets in headless Chrome).
import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../config';
import { AudioCapture } from '../audio/AudioCapture';
import type { NoiseState } from '../audio/noise';
import { Badge, Button, Card, CardHeader, ErrorNote } from '../components/ui';
import { EventLogView } from '../components/session';
import { eventLog } from '../lib/debug';

export function MicCheck({ settings }: { settings: AppSettings }) {
  const cap = useRef<{ c: AudioCapture; ctx: AudioContext } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [meter, setMeter] = useState({ levelDb: -100, prob: 0, floorDb: null as number | null, noise: 'quiet' as NoiseState });
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => () => void cap.current?.c.stop().then(() => cap.current?.ctx.close()), []);

  const start = async () => {
    setError('');
    const ctx = new AudioContext();
    let last = 0;
    const c = new AudioCapture({
      ctx,
      settings,
      firstPhraseId: 1,
      onFrame: (levelDb, prob) => {
        const now = performance.now();
        if (now - last < 100) return;
        last = now;
        setMeter(m => ({ ...m, levelDb, prob, floorDb: c.machine.noise.floorDb }));
      },
      onEvent: e => {
        if (e.type === 'noise_state') setMeter(m => ({ ...m, noise: e.state }));
        if (e.type === 'chunk') eventLog.log('miccheck.chunk', { phraseId: e.phraseId, seq: e.seq, ms: Math.round(e.pcm.length / 16), final: e.final });
        else eventLog.log(`miccheck.${e.type}`, { ...e });
        setCounts(n => ({ ...n, [e.type]: (n[e.type] ?? 0) + 1 }));
      },
    });
    cap.current = { c, ctx };
    try {
      await c.start();
      setRunning(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      eventLog.log('miccheck.error', { error: String(err) });
    }
  };

  const stop = async () => {
    await cap.current?.c.stop();
    await cap.current?.ctx.close();
    cap.current = null;
    setRunning(false);
  };

  return (
    <div data-testid="miccheck-screen" className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Microphone check</h1>
      <p className="text-sm text-muted-foreground">Nothing is sent anywhere. Speak and watch the voice detection.</p>
      <ErrorNote>{error}</ErrorNote>
      <Card>
        <CardHeader title="Voice detection">
          {running ? (
            <Button size="sm" variant="secondary" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" data-testid="miccheck-start" onClick={start}>
              Start
            </Button>
          )}
        </CardHeader>
        <div className="flex flex-wrap gap-2 p-4 font-mono text-xs" data-testid="miccheck-meter" data-running={running}>
          <Badge>level {meter.levelDb.toFixed(0)} dBFS</Badge>
          <Badge>speech p {meter.prob.toFixed(2)}</Badge>
          <Badge data-testid="noise-indicator" data-noise={meter.noise}>
            floor {meter.floorDb === null ? '—' : meter.floorDb.toFixed(0)} dBFS · {meter.noise}
          </Badge>
          {Object.entries(counts).map(([k, v]) => (
            <Badge key={k} data-testid={`miccheck-count-${k}`}>
              {k}: {v}
            </Badge>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Events" />
        <div className="p-4">
          <EventLogView />
        </div>
      </Card>
    </div>
  );
}
