// SpeechNormalizer: safety net turning leftover symbols into words ("3/4" -> "three quarters").
// Owned by the worker stream.

export function normalizeForSpeech(sentence: string): string {
  // TODO(worker stream): fractions, operators, decimals, percent, parentheses, LaTeX remnants.
  return sentence;
}
