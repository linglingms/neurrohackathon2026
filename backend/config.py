"""Configuration settings for the NeuroHackathon Lie Detector App."""

import os

# OpenBCI Hardware Configuration
SAMPLING_RATE = 125  # Hz — Cyton+Daisy runs at 125 Hz
EEG_CHANNELS = 16
BOARD_ID = 2  # OpenBCI Cyton+Daisy
SERIAL_PORT = os.getenv('OPENBCI_PORT', 'COM4')

# Signal Processing
FILTER_LOW_FREQ = 1  # Hz
FILTER_HIGH_FREQ = 50  # Hz
WINDOW_SIZE = 125  # Samples per window (1 second at 125 Hz)
OVERLAP = 0.5  # 50% overlap

# Frequency Bands (Hz)
DELTA = (0.5, 4)
THETA = (4, 8)
ALPHA = (8, 12)
BETA = (12, 30)
GAMMA = (30, 100)

# Model Configuration
MODEL_PATH = "models/lie_detector_model.h5"
SCALER_PATH = "models/scaler.pkl"
FEATURE_DIM = 12  # Number of features extracted per window

# Deception Detection Thresholds
DECEPTION_THRESHOLD = 0.7  # Probability threshold for deception classification

# Data Collection
CALIBRATION_DURATION = 60  # Seconds for baseline calibration
TEST_DURATION = 120  # Seconds per test session
