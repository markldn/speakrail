#!/usr/bin/env bash
# Speakrail TTS: the Breeze TTS 2 streaming API (POST /v1/audio/speech) on the slim profile.
#
#   MODELS_DIR / BREEZE_MODEL   weights from model-init (default $MODELS_DIR/breeze-tts-2)
#   TTS_HOST / TTS_PORT         where the API listens (default 0.0.0.0:7860)
#   BREEZE_INT8                 int8 weight-only parts (default backbone,text_encoder,depth; empty = bf16)
#   BREEZE_FAST_CONFIG          CUDA-graph profile (default configs/slim.json)
set -euo pipefail

BREEZE_MODEL=${BREEZE_MODEL:-${MODELS_DIR:-/models}/breeze-tts-2}
[ -e "$BREEZE_MODEL/config.json" ] || { echo "tts: no Breeze model at $BREEZE_MODEL" >&2; exit 1; }

FAST_ARGS=()
IFS=',' read -r -a FAST_STAGES <<< "${BREEZE_FAST_FLAGS:-}"
for stage in "${FAST_STAGES[@]}"; do
  case "$stage" in
    "") ;;
    text_encoder) FAST_ARGS+=(--fast-text-encoder) ;;
    backbone_prefill) FAST_ARGS+=(--fast-backbone-prefill) ;;
    backbone_decode) FAST_ARGS+=(--fast-backbone-decode) ;;
    depth_decoder) FAST_ARGS+=(--fast-depth-decoder) ;;
    codec) FAST_ARGS+=(--fast-codec) ;;
    *) echo "tts: unsupported BREEZE_FAST_FLAGS stage '$stage'" >&2; exit 2 ;;
  esac
done

cd /opt/breeze
exec python -m breeze_infer.api "$BREEZE_MODEL" --host "${TTS_HOST:-0.0.0.0}" --port "${TTS_PORT:-7860}" "${FAST_ARGS[@]}"
