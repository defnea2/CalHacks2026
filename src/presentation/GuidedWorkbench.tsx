import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { demoLessons } from "./demo-lessons";
import type { BeatInput, PlaybackToken } from "./contracts";
import { NarrationAudio } from "./NarrationAudio";
import { TeachingCanvas } from "./TeachingCanvas";
import { VisualDirector } from "./VisualDirector";

type Stage =
  | { kind: "main"; index: number }
  | { kind: "retry" | "success"; index: number };
export function GuidedWorkbench() {
  const [director] = useState(() => new VisualDirector());
  const snapshot = useSyncExternalStore(
    director.subscribe,
    director.getSnapshot,
  );
  const [lessonId, setLessonId] = useState(demoLessons[0].id);
  const lesson = demoLessons.find((item) => item.id === lessonId)!;
  const [stage, setStage] = useState<Stage>({ kind: "main", index: 0 });
  const [manual, setManual] = useState(false);
  const sessionRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const begin = (beat: BeatInput, next: Stage) => {
    audioRef.current?.pause();
    setDuration(0);
    setError("");
    try {
      director.prepare(beat);
      setStage(next);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "This explanation needs a fix.",
      );
    }
  };
  useEffect(() => {
    if (
      snapshot.status === "completed" &&
      stage.kind === "main" &&
      stage.index < lesson.beats.length - 1
    )
      begin(lesson.beats[stage.index + 1], {
        kind: "main",
        index: stage.index + 1,
      });
  }, [snapshot.status, snapshot.token?.runId]);
  useEffect(
    () => () => {
      audioRef.current?.pause();
      director.reset();
    },
    [director],
  );
  const reset = () => {
    audioRef.current?.pause();
    director.reset();
    setStage({ kind: "main", index: 0 });
    setError("");
    setDuration(0);
  };
  const choose = (nodeId: string) => {
    if (!director.respond(nodeId)) return;
    begin(nodeId === lesson.answerId ? lesson.success : lesson.retry, {
      kind: nodeId === lesson.answerId ? "success" : "retry",
      index: stage.index,
    });
  };
  const replay = () => {
    audioRef.current?.pause();
    setError("");
    setDuration(0);
    director.replay();
  };
  const manualCue = (token: PlaybackToken) => {
    const before = director.getSnapshot();
    director.narrationStarted(token);
    if (before.status === "ready") {
      director.narrationPaused(token);
      return;
    }
    const next = before.beat?.cues.find(
      (cue) => !before.appliedCueIds.includes(cue.id),
    );
    if (next) {
      director.narrationProgress(token, next.atMs);
      director.narrationPaused(token);
    } else director.narrationEnded(token);
  };
  const primary = () => {
    setError("");
    if (snapshot.status === "idle") {
      sessionRef.current?.scrollIntoView({
        block: "start",
        behavior: "instant",
      });
      begin(lesson.beats[0], { kind: "main", index: 0 });
      return;
    }
    if (snapshot.status === "interrupted" || snapshot.status === "error") {
      replay();
      return;
    }
    if (snapshot.status === "completed") {
      reset();
      begin(lesson.beats[0], { kind: "main", index: 0 });
      return;
    }
    if (!snapshot.token) return;
    if (manual) {
      manualCue(snapshot.token);
      return;
    }
    if (snapshot.status === "speaking") audioRef.current?.pause();
    else
      audioRef.current
        ?.play()
        .catch(() =>
          setError("Audio playback is unavailable. Try manual cues."),
        );
  };
  const label =
    snapshot.status === "idle"
      ? "Start explanation"
      : snapshot.status === "interrupted" || snapshot.status === "error"
        ? "Replay this part"
        : snapshot.status === "completed"
          ? "Explore again"
          : snapshot.status === "awaiting_answer"
            ? "Your turn"
            : manual
              ? "Next visual cue"
              : snapshot.status === "speaking"
                ? "Pause"
                : "Play";
  const awaiting = snapshot.status === "awaiting_answer";
  const statusText = awaiting
    ? "YOUR TURN"
    : snapshot.status === "interrupted"
      ? "PAUSED FOR YOU"
      : snapshot.status === "speaking"
        ? "EXPLAINING"
        : snapshot.status === "completed"
          ? "NICELY EXPLORED"
          : snapshot.status === "paused"
            ? "PAUSED"
            : "READY WHEN YOU ARE";
  return (
    <div className="guided-workbench">
      <div className="guided-toolbar">
        <label>
          Explore an idea
          <select
            aria-label="Guided example"
            value={lessonId}
            onChange={(event) => {
              reset();
              setLessonId(event.target.value);
            }}
          >
            {demoLessons.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <span className="guided-demo-badge">
          Scripted tutor rehearsal ·{" "}
          {manual ? "manual cues" : "recorded narration"}
        </span>
      </div>
      <div className="guided-session" ref={sessionRef}>
        <TeachingCanvas
          canvas={snapshot.canvas}
          choiceIds={awaiting ? snapshot.beat?.question?.nodeIds : []}
          onChoose={choose}
        />
        <div className="narration-panel">
          <div className="tutor-avatar" aria-hidden="true">
            ✦
          </div>
          <div className="narration-body">
            <div className="narration-meta">
              <span>YOUR TUTOR</span>
              <span role="status">{statusText}</span>
            </div>
            <p className="narration-text">
              {snapshot.beat?.narration ||
                "Let’s take an idea apart, one small discovery at a time. I’ll show you as we go."}
            </p>
            {snapshot.token && duration > 0 && (
              <div
                className="narration-progress"
                role="progressbar"
                aria-label="Narration progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  Math.min(100, (snapshot.elapsedMs / (duration * 1000)) * 100),
                )}
              >
                <div
                  style={{
                    width: `${Math.min(100, (snapshot.elapsedMs / (duration * 1000)) * 100)}%`,
                  }}
                />
              </div>
            )}
          </div>
        </div>
        {awaiting && (
          <div className="guided-question">
            <h3>{snapshot.beat?.question?.prompt}</h3>
            <p>
              Choose an outlined object in the picture. You can use Tab and
              Enter, too.
            </p>
          </div>
        )}
        <div className="narration-controls">
          <button
            className="play-primary"
            disabled={awaiting}
            onClick={primary}
          >
            {label}
          </button>
          <button
            disabled={
              !["ready", "speaking", "paused"].includes(snapshot.status)
            }
            onClick={() => {
              audioRef.current?.pause();
              if (snapshot.token) director.interrupt(snapshot.token);
            }}
          >
            Wait, pause here
          </button>
          <button
            disabled={!snapshot.beat || snapshot.status === "speaking"}
            onClick={replay}
          >
            Show that again
          </button>
          <button onClick={reset}>Start over</button>
        </div>
      </div>
      {(error || snapshot.error) && (
        <p className="guided-error" role="alert">
          {error || snapshot.error}
        </p>
      )}
      {snapshot.token && !manual && (
        <NarrationAudio
          key={snapshot.token.runId}
          director={director}
          token={snapshot.token}
          src={`/demo-narration/${snapshot.beat!.id}.wav`}
          audioRef={audioRef}
          onError={setError}
          onDuration={setDuration}
        />
      )}
      <details className="guided-debug">
        <summary>Rehearsal controls & voice integration</summary>
        <p>
          This is a scripted replay, not a connected AI tutor. Its visual cues
          follow the recording’s actual playback clock. A live voice teammate
          can send explanation beats and the same start, progress, end, and
          interruption events.
        </p>
        <button
          onClick={() => {
            audioRef.current?.pause();
            setManual((value) => !value);
            setError("");
            if (snapshot.token) {
              setDuration(0);
              director.replay();
            }
          }}
        >
          {manual ? "Use recorded narration" : "Use manual cues"}
        </button>
        <p>
          Interrupting cancels pending cues. Replaying restores the start of
          this explanation part. New parts keep the canvas built so far.
        </p>
        <pre>
          {JSON.stringify(
            {
              status: snapshot.status,
              token: snapshot.token,
              elapsedMs: Math.round(snapshot.elapsedMs),
              appliedCueIds: snapshot.appliedCueIds,
              beat: snapshot.beat,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
