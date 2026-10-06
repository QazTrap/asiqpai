"""Private ASIQPAI DeepFilterNet worker. Deploy separately from the Node backend."""
import asyncio
import hmac
import os
import wave
from contextlib import asynccontextmanager

import torch
import torchaudio
from df.enhance import enhance, init_df
from fastapi import FastAPI, HTTPException, Request, Response
from wav_io import MAX_BYTES, decode_wav, encode_wav

TOKEN = os.environ.get('STUDIO_AI_TOKEN', '')
if len(TOKEN) < 32:
    raise RuntimeError('Set STUDIO_AI_TOKEN to a random secret of at least 32 characters')

model = None
state = None
busy = False

def load_model():
    global model, state
    torch.set_num_threads(max(1, int(os.environ.get('STUDIO_CPU_THREADS', '2'))))
    loaded = init_df(log_file=None)
    model, state = loaded[:2]

@asynccontextmanager
async def lifespan(_app):
    await asyncio.to_thread(load_model)
    yield

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

def authorize(request):
    if not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {TOKEN}'):
        raise HTTPException(401, 'Unauthorized')

@app.get('/healthz')
async def healthz():
    return {'ready': model is not None}

@app.get('/health')
async def health(request: Request):
    authorize(request)
    return {'ready': model is not None}

def process(data):
    samples, rate = decode_wav(data)
    audio = torch.from_numpy(samples).unsqueeze(0)
    if rate != state.sr():
        audio = torchaudio.functional.resample(audio, rate, state.sr())
    with torch.inference_mode():
        # Compensate algorithmic delay so the cleaned vocal stays aligned to the beat.
        output = enhance(model, state, audio, pad=True)
    result = output.squeeze(0).cpu().numpy()[:audio.shape[-1]]
    return encode_wav(result, state.sr())

@app.post('/enhance')
async def denoise(request: Request):
    global busy
    authorize(request)
    if busy:
        raise HTTPException(429, 'Worker busy')
    busy = True
    try:
        data = bytearray()
        async with asyncio.timeout(30):
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise HTTPException(413, 'Audio too large')
        # The inference thread continues even if the client disconnects. Keep the
        # singleton model locked until it really finishes; no shared state races.
        task = asyncio.create_task(asyncio.to_thread(process, bytes(data)))
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
        return Response(result, media_type='audio/wav', headers={'Cache-Control': 'no-store'})
    except (ValueError, EOFError, wave.Error) as error:
        raise HTTPException(400, 'Invalid mono WAV') from error
    except TimeoutError as error:
        raise HTTPException(408, 'Upload timeout') from error
    finally:
        busy = False
