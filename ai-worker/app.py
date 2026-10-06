"""Private ASIQPAI vocal AI worker: DeepFilterNet cleanup + WORLD pitch correction."""
import asyncio
import hmac
import math
import os
import wave
from contextlib import asynccontextmanager

import numpy as np
import pyworld as pw
import torch
import torchaudio
from df.enhance import enhance, init_df
from fastapi import FastAPI, HTTPException, Request, Response
from wav_io import MAX_BYTES, decode_wav, encode_wav

TOKEN = os.environ.get("STUDIO_AI_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("Set STUDIO_AI_TOKEN to a random secret of at least 32 characters")

NOTE_ROOTS = {
    "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
    "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}
SCALES = {
    "minor": (0, 2, 3, 5, 7, 8, 10),
    "major": (0, 2, 4, 5, 7, 9, 11),
}

model = None
state = None
busy = False


def load_model():
    global model, state
    torch.set_num_threads(max(1, int(os.environ.get("STUDIO_CPU_THREADS", "2"))))
    loaded = init_df(log_file=None)
    model, state = loaded[:2]


@asynccontextmanager
async def lifespan(_app):
    await asyncio.to_thread(load_model)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def authorize(request):
    if not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        raise HTTPException(401, "Unauthorized")


@app.get("/healthz")
async def healthz():
    return {"ready": model is not None, "tuneAvailable": True}


@app.get("/health")
async def health(request: Request):
    authorize(request)
    return {"ready": model is not None, "tuneAvailable": True}


def parse_bool(value, default=False):
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_tune_config(request):
    enabled = parse_bool(request.headers.get("x-studio-tune"), False)
    if not enabled:
        return None

    key = request.headers.get("x-studio-key", "F").strip().upper()
    scale = request.headers.get("x-studio-scale", "minor").strip().lower()
    if key not in NOTE_ROOTS or scale not in SCALES:
        raise HTTPException(400, "Invalid tune key or scale")

    try:
        amount = int(request.headers.get("x-studio-amount", "70"))
        speed = int(request.headers.get("x-studio-speed", "35"))
    except ValueError as error:
        raise HTTPException(400, "Invalid tune settings") from error

    if not 0 <= amount <= 100 or not 0 <= speed <= 100:
        raise HTTPException(400, "Invalid tune settings")

    return {"key": key, "scale": scale, "amount": amount, "speed": speed}


def nearest_scale_note(midi_value, root_pc, scale_steps):
    allowed = {(root_pc + step) % 12 for step in scale_steps}
    center = int(math.floor(midi_value))
    candidates = [note for note in range(center - 3, center + 5) if note % 12 in allowed]
    return min(candidates, key=lambda note: abs(note - midi_value))


def smooth_midi(values, voiced, speed):
    # speed=100 behaves like hard tune; low speed follows notes more naturally.
    alpha = 0.055 + 0.945 * (max(0.0, min(1.0, speed / 100.0)) ** 1.7)
    result = values.copy()
    previous = None
    for i in range(len(values)):
        if not voiced[i]:
            previous = None
            continue
        current = values[i]
        if previous is None:
            previous = current
        else:
            previous = previous + alpha * (current - previous)
        result[i] = previous
    return result


def tune_samples(samples, rate, config):
    if config is None or config["amount"] <= 0:
        return samples

    x = np.ascontiguousarray(samples, dtype=np.float64)
    # WORLD is efficient at a 5 ms frame period and preserves timing/formants much
    # better than changing playback speed.
    raw_f0, time_axis = pw.dio(
        x,
        rate,
        f0_floor=65.0,
        f0_ceil=1100.0,
        frame_period=5.0,
    )
    f0 = pw.stonemask(x, raw_f0, time_axis, rate)
    voiced = f0 > 0.0
    if not np.any(voiced):
        return samples

    midi = np.zeros_like(f0, dtype=np.float64)
    midi[voiced] = 69.0 + 12.0 * np.log2(f0[voiced] / 440.0)

    root_pc = NOTE_ROOTS[config["key"]]
    steps = SCALES[config["scale"]]
    amount = config["amount"] / 100.0

    corrected = midi.copy()
    voiced_indices = np.flatnonzero(voiced)
    for i in voiced_indices:
        target = nearest_scale_note(midi[i], root_pc, steps)
        corrected[i] = midi[i] + (target - midi[i]) * amount

    corrected = smooth_midi(corrected, voiced, config["speed"])

    tuned_f0 = f0.copy()
    tuned_f0[voiced] = 440.0 * np.power(2.0, (corrected[voiced] - 69.0) / 12.0)

    spectral = pw.cheaptrick(x, f0, time_axis, rate)
    aperiodicity = pw.d4c(x, f0, time_axis, rate)
    output = pw.synthesize(tuned_f0, spectral, aperiodicity, rate)

    if len(output) < len(samples):
        output = np.pad(output, (0, len(samples) - len(output)))
    output = output[: len(samples)]
    return np.asarray(output, dtype=np.float32)


def process_audio(data, clean=True, tune_config=None):
    samples, rate = decode_wav(data)

    if clean:
        audio = torch.from_numpy(samples).unsqueeze(0)
        if rate != state.sr():
            audio = torchaudio.functional.resample(audio, rate, state.sr())
        with torch.inference_mode():
            # Compensate algorithmic delay so the cleaned vocal stays aligned.
            output = enhance(model, state, audio, pad=True)
        samples = output.squeeze(0).cpu().numpy()[: audio.shape[-1]]
        rate = state.sr()

    if tune_config is not None:
        samples = tune_samples(samples, rate, tune_config)

    return encode_wav(samples, rate)


@app.post("/enhance")
async def process(request: Request):
    global busy
    authorize(request)
    if busy:
        raise HTTPException(429, "Worker busy")

    clean = parse_bool(request.headers.get("x-studio-clean"), True)
    tune_config = parse_tune_config(request)
    if not clean and tune_config is None:
        raise HTTPException(400, "No vocal processing selected")

    busy = True
    try:
        data = bytearray()
        async with asyncio.timeout(30):
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise HTTPException(413, "Audio too large")

        task = asyncio.create_task(
            asyncio.to_thread(process_audio, bytes(data), clean, tune_config)
        )
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

        return Response(
            result,
            media_type="audio/wav",
            headers={"Cache-Control": "no-store"},
        )
    except (ValueError, EOFError, wave.Error) as error:
        raise HTTPException(400, "Invalid mono WAV") from error
    except TimeoutError as error:
        raise HTTPException(408, "Upload timeout") from error
    finally:
        busy = False
