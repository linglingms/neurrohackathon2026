"""EEG signal processing and feature extraction module."""

import numpy as np
from scipy import signal, fftpack
from scipy.stats import skew, kurtosis

try:
    import backend.config as config
except ImportError:
    import config as config


class EEGProcessor:
    """Processes raw EEG signals and extracts features."""

    def __init__(self):
        """Initialize the EEG processor with filter coefficients."""
        self.nyquist = config.SAMPLING_RATE / 2
        self.create_filters()

    def create_filters(self):
        """Create bandpass and notch filters."""
        low = config.FILTER_LOW_FREQ / self.nyquist
        high = config.FILTER_HIGH_FREQ / self.nyquist
        self.b, self.a = signal.butter(4, [low, high], btype='band')

    def bandpass_filter(self, data):
        """Apply bandpass filter to EEG data."""
        return signal.filtfilt(self.b, self.a, data)

    def notch_filter(self, data, freq=60):
        """Apply notch filter to remove powerline interference."""
        Q = 30
        w = freq / self.nyquist
        b, a = signal.iirnotch(w, Q)
        return signal.filtfilt(b, a, data)

    def extract_frequency_features(self, data):
        """Extract power spectral features in frequency bands."""
        fft = np.abs(fftpack.fft(data))
        freqs = fftpack.fftfreq(len(data), 1 / config.SAMPLING_RATE)
        
        features = {}
        for band_name, (low, high) in [
            ('delta', config.DELTA),
            ('theta', config.THETA),
            ('alpha', config.ALPHA),
            ('beta', config.BETA),
            ('gamma', config.GAMMA),
        ]:
            band_power = np.sum(fft[(freqs >= low) & (freqs <= high)] ** 2)
            features[band_name] = band_power

        return features

    def extract_time_domain_features(self, data):
        """Extract time-domain statistical features."""
        return {
            'mean': np.mean(data),
            'std': np.std(data),
            'max': np.max(data),
            'min': np.min(data),
            'rms': np.sqrt(np.mean(data ** 2)),
            'skewness': skew(data),
            'kurtosis': kurtosis(data),
        }

    def extract_features(self, window):
        """Extract all features from a window of EEG data."""
        filtered = self.bandpass_filter(window)
        filtered = self.notch_filter(filtered)
        
        features = {}
        features.update(self.extract_time_domain_features(filtered))
        features.update(self.extract_frequency_features(filtered))
        
        return features

    def process_batch(self, data):
        """Process a batch of EEG data with sliding windows."""
        step = int(config.WINDOW_SIZE * (1 - config.OVERLAP))
        windows = []

        if len(data) < config.WINDOW_SIZE or step <= 0:
            return windows

        for i in range(0, len(data) - config.WINDOW_SIZE + 1, step):
            window = data[i:i + config.WINDOW_SIZE]
            windows.append(self.extract_features(window))

        return windows
