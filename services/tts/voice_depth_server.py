"""Add a controlled voice-depth setting to the Breeze HTTP API."""
from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from breeze_infer import api

_reconfiguring = False


def get_voice_depth() -> JSONResponse:
    return JSONResponse({
        "levels": int(os.environ.get("BREEZE_DEPTH_LEVELS", "16")),
        "restarting": _reconfiguring,
    })


def _restart_for_voice_depth() -> None:
    os.execv(sys.executable, [sys.executable, "-m", "voice_depth_server", *sys.argv[1:]])


async def set_voice_depth(payload: dict) -> JSONResponse:
    global _reconfiguring
    try:
        levels = int(payload.get("levels", -1))
    except (AttributeError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="levels must be an integer from 10 to 16")
    if not 10 <= levels <= 16:
        raise HTTPException(status_code=400, detail="levels must be between 10 and 16")
    if _reconfiguring:
        raise HTTPException(status_code=503, detail="TTS is already restarting")
    current = int(os.environ.get("BREEZE_DEPTH_LEVELS", "16"))
    if levels == current:
        return JSONResponse({"status": "unchanged", "levels": current})
    if not api._request_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Stop the active speech session before changing voice fidelity")
    try:
        profile = Path("/data/breeze_depth_levels")
        profile.parent.mkdir(parents=True, exist_ok=True)
        temporary = profile.with_suffix(".tmp")
        temporary.write_text(f"{levels}\n")
        os.replace(temporary, profile)
        os.environ["BREEZE_DEPTH_LEVELS"] = str(levels)
        _reconfiguring = True
    except OSError as exc:
        api._request_lock.release()
        raise HTTPException(status_code=500, detail=f"Could not save voice setting: {exc}")
    api._request_lock.release()
    timer = threading.Timer(0.5, _restart_for_voice_depth)
    timer.daemon = True
    timer.start()
    return JSONResponse({"status": "restarting", "levels": levels}, status_code=202)


api.app.add_api_route("/admin/voice-depth", get_voice_depth, methods=["GET"])
api.app.add_api_route("/admin/voice-depth", set_voice_depth, methods=["POST"])
api.main()
