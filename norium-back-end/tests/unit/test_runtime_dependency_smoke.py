import io
import unittest
import wave

from app.infrastructure.runtime_dependency_smoke import library_smoke, require_opus_probe, synthetic_wav


class RuntimeDependencySmokeTests(unittest.TestCase):
    def test_synthetic_audio_has_exact_format_and_duration(self):
        with wave.open(io.BytesIO(synthetic_wav()), "rb") as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()),
                             (1, 2, 48000, 12000))
            self.assertTrue(any(audio.readframes(12000)))

    def test_probe_requires_the_application_opus_format(self):
        valid = {"codec_name": "opus", "sample_rate": "48000", "channels": 1}
        require_opus_probe({"streams": [valid]})
        for changes in ({"codec_name": "aac"}, {"sample_rate": "44100"}, {"channels": 2}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                require_opus_probe({"streams": [{**valid, **changes}]})
        with self.assertRaises(RuntimeError):
            require_opus_probe({"streams": []})

    def test_native_python_dependencies_roundtrip_synthetic_data(self):
        library_smoke()
