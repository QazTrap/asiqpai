"""Bounded PCM input/output. No remote URLs, files or codecs accepted from users."""
import io
import wave
import numpy as np

MAX_SECONDS = 180
MAX_BYTES = 20 * 1024 * 1024

def decode_wav(data):
    if len(data) > MAX_BYTES:
        raise ValueError('Audio is too large')
    with wave.open(io.BytesIO(data), 'rb') as f:
        rate, frames = f.getframerate(), f.getnframes()
        if f.getnchannels() != 1 or f.getsampwidth() != 2 or f.getcomptype() != 'NONE':
            raise ValueError('Expected mono PCM16 WAV')
        if rate not in (16000, 22050, 24000, 32000, 44100, 48000, 96000) or not 0 < frames <= rate * MAX_SECONDS:
            raise ValueError('Invalid rate or duration')
        raw = f.readframes(frames)
        if len(raw) != frames * 2:
            raise ValueError('Truncated WAV')
        return np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768, rate

def encode_wav(samples, rate):
    data = io.BytesIO()
    with wave.open(data, 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate)
        f.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
    return data.getvalue()
