"""Live EEG streaming from Lab Streaming Layer (LSL)."""

import logging
import time
import numpy as np

try:
    from pylsl import StreamInlet, resolve_byprop
    PYLSL_AVAILABLE = True
except ImportError:
    StreamInlet = None
    resolve_byprop = None
    PYLSL_AVAILABLE = False

logger = logging.getLogger(__name__)


class LSLStream:
    """Manages a live LSL EEG inlet."""

    def __init__(self, stream_type="EEG", stream_name=None, eeg_channels=16, sampling_rate=125):
        self.stream_type = stream_type
        self.stream_name = stream_name
        self.eeg_channels = int(eeg_channels)
        self.sampling_rate = int(sampling_rate)
        self.inlet = None
        self.connected = False
        self.active_stream_name = None
        self.active_source_id = None

    def available_streams(self, timeout=1.0):
        """Return currently visible LSL streams for the configured type."""
        if not PYLSL_AVAILABLE:
            return []

        streams = resolve_byprop("type", self.stream_type, timeout=timeout)
        items = []
        for info in streams:
            items.append({
                "name": info.name(),
                "type": info.type(),
                "channel_count": info.channel_count(),
                "nominal_srate": info.nominal_srate(),
                "source_id": info.source_id(),
            })
        return items

    def connect(self, stream_name=None, timeout=2.0):
        """Connect to the first matching EEG stream, optionally by stream name."""
        if not PYLSL_AVAILABLE:
            raise RuntimeError("pylsl is not installed. Run: pip install pylsl")

        target_name = stream_name or self.stream_name
        streams = resolve_byprop("type", self.stream_type, timeout=timeout)

        if target_name:
            streams = [s for s in streams if s.name() == target_name]

        if not streams:
            label = f" named '{target_name}'" if target_name else ""
            raise RuntimeError(f"No LSL stream of type '{self.stream_type}'{label} found")

        info = streams[0]
        self.inlet = StreamInlet(info, max_buflen=60, max_chunklen=32, recover=True)
        # Warm-up pull to ensure stream is active.
        _samples, _timestamps = self.inlet.pull_chunk(timeout=0.2, max_samples=8)

        self.connected = True
        self.active_stream_name = info.name()
        self.active_source_id = info.source_id()
        logger.info("Connected to LSL stream '%s' (%s)", self.active_stream_name, self.active_source_id)

    def get_data(self, n_samples=None):
        """Return EEG data as numpy array with shape (channels, samples)."""
        if not self.connected or self.inlet is None:
            raise RuntimeError("LSL stream not connected")

        target_samples = int(n_samples or self.sampling_rate)
        if target_samples <= 0:
            target_samples = self.sampling_rate

        samples = []
        deadline = time.time() + 2.0

        while len(samples) < target_samples and time.time() < deadline:
            chunk, _timestamps = self.inlet.pull_chunk(timeout=0.2, max_samples=target_samples)
            if chunk:
                samples.extend(chunk)

        if not samples:
            raise RuntimeError("No samples received from LSL stream")

        array = np.asarray(samples, dtype=float)
        if array.ndim != 2:
            raise RuntimeError(f"Unexpected LSL sample shape: {array.shape}")

        # Convert from (samples, channels) to (channels, samples).
        array = array.T

        if array.shape[0] > self.eeg_channels:
            array = array[: self.eeg_channels, :]
        elif array.shape[0] < self.eeg_channels:
            pad = np.zeros((self.eeg_channels - array.shape[0], array.shape[1]))
            array = np.vstack([array, pad])

        return array

    def disconnect(self):
        """Release the LSL inlet."""
        if self.inlet is not None:
            try:
                self.inlet.close_stream()
            except Exception:
                pass

        self.inlet = None
        self.connected = False
        self.active_stream_name = None
        self.active_source_id = None
        logger.info("LSL stream disconnected")
