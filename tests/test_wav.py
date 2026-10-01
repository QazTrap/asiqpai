import io
import sys
import unittest
import wave
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ai-worker'))
from wav_io import decode_wav, encode_wav

class WavTests(unittest.TestCase):
    def test_roundtrip(self):
        data = np.array([0, -.5, .5, 1], dtype=np.float32)
        restored, rate = decode_wav(encode_wav(data, 48000))
        self.assertEqual(rate, 48000)
        np.testing.assert_allclose(restored, data, atol=1/16000)

    def test_reject_stereo(self):
        out = io.BytesIO()
        with wave.open(out, 'wb') as f:
            f.setnchannels(2); f.setsampwidth(2); f.setframerate(48000); f.writeframes(bytes(16))
        with self.assertRaises(ValueError): decode_wav(out.getvalue())

    def test_reject_truncated(self):
        data = encode_wav(np.ones(100), 48000)
        with self.assertRaises(ValueError): decode_wav(data[:-10])

    def test_reject_long(self):
        with self.assertRaises(ValueError): decode_wav(encode_wav(np.zeros(16000*181), 16000))
