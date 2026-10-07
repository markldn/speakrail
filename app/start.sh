#!/usr/bin/env bash
# Speakrail app: render the phrase cache for the voice once (needs the TTS service), then serve the UI.
set -euo pipefail
cd /app
VOICE=${VOICE:-female_a.wav}
case "$VOICE" in */*) ;; *) VOICE="/app/voices/$VOICE" ;; esac   # a bare name = one of app/voices/
export VOICE
case " $* " in *" --stub "*) exec python server.py "$@" ;; esac          # no TTS in stub mode
case " $* " in *" --no-phrase-cache "*) exec python server.py "$@" ;; esac # skip optional cache render for constrained/slow startup
python phrase_cache.py render --voice "$VOICE" --urls "${TTS_URL:-http://127.0.0.1:7860/v1/audio/speech}" || \
  echo "app: phrase cache not rendered (replies then start without pre-rendered first clauses)" >&2
exec python server.py "$@"
