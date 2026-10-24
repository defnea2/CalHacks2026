import { useEffect, type RefObject } from "react";
import type { PlaybackToken } from "./contracts";
import type { VisualDirector } from "./VisualDirector";

/** Reference media adapter. Every cue uses actual playback time, never a text-length timer. */
export function NarrationAudio({
  director,
  token,
  src,
  audioRef,
  autoPlay = true,
  onError,
  onDuration,
}: {
  director: VisualDirector;
  token: PlaybackToken;
  src: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  autoPlay?: boolean;
  onError(message: string): void;
  onDuration(seconds: number): void;
}) {
  useEffect(() => {
    const player = audioRef.current;
    let active = true;
    if (autoPlay)
      player?.play().catch(() => {
        if (active)
          onError(
            "Press Play to start the narration, or switch to manual cues.",
          );
      });
    return () => {
      active = false;
      if (player && !player.paused) player.pause();
    };
  }, [token.runId, autoPlay]);
  return (
    <audio
      ref={audioRef}
      src={src}
      preload="auto"
      onPlaying={() => director.narrationStarted(token)}
      onTimeUpdate={(event) =>
        director.narrationProgress(
          token,
          event.currentTarget.currentTime * 1000,
        )
      }
      onPause={() => director.narrationPaused(token)}
      onEnded={() => director.narrationEnded(token)}
      onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
      onError={() => {
        director.interrupt(token);
        onError(
          "The demo recording could not load. You can still rehearse the visual cues manually.",
        );
      }}
    />
  );
}
