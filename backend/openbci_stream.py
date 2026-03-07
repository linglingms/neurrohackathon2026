"""Live EEG streaming from OpenBCI Cyton+Daisy via BrainFlow."""

import logging
import numpy as np
from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds, BrainFlowError

logger = logging.getLogger(__name__)


class OpenBCIStream:
    """Manages a live BrainFlow session with the Cyton+Daisy board."""

    def __init__(self, serial_port='COM3'):
        self.board_id = BoardIds.CYTON_DAISY_BOARD.value
        self.serial_port = serial_port
        self.board = None
        self.connected = False
        self.eeg_channels = BoardShim.get_eeg_channels(self.board_id)
        self.sampling_rate = BoardShim.get_sampling_rate(self.board_id)

    def connect(self):
        """Prepare and start streaming from the board."""
        params = BrainFlowInputParams()
        params.serial_port = self.serial_port
        self.board = BoardShim(self.board_id, params)
        self.board.prepare_session()
        self.board.start_stream()
        self.connected = True
        logger.info(f"Cyton+Daisy connected on {self.serial_port} @ {self.sampling_rate} Hz")

    def get_data(self, n_samples=None):
        """Return EEG data as numpy array of shape (16, n_samples).

        If n_samples is given, returns the latest n samples without clearing
        the buffer. Otherwise drains the full buffer.
        """
        if not self.connected:
            raise RuntimeError("Stream not connected — call connect() first")
        if n_samples:
            data = self.board.get_current_board_data(n_samples)
        else:
            data = self.board.get_board_data()
        return data[self.eeg_channels]  # (16, n_samples)

    def disconnect(self):
        """Stop streaming and release the board."""
        if self.board and self.connected:
            self.board.stop_stream()
            self.board.release_session()
            self.connected = False
            logger.info("Cyton+Daisy disconnected")
