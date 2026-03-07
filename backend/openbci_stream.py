"""Live EEG streaming from OpenBCI Cyton+Daisy via BrainFlow."""

import logging
import numpy as np

try:
    from serial.tools import list_ports
    SERIAL_TOOLS_AVAILABLE = True
except ImportError:
    list_ports = None
    SERIAL_TOOLS_AVAILABLE = False

try:
    from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
    BRAINFLOW_AVAILABLE = True
except ImportError:
    BoardShim = None
    BrainFlowInputParams = None
    BoardIds = None
    BRAINFLOW_AVAILABLE = False

logger = logging.getLogger(__name__)


class OpenBCIStream:
    """Manages a live BrainFlow session with the Cyton+Daisy board."""

    def __init__(self, serial_port='COM3'):
        self.serial_port = serial_port
        self.board = None
        self.connected = False
        self.board_id = BoardIds.CYTON_DAISY_BOARD.value if BRAINFLOW_AVAILABLE else None
        self.eeg_channels = BoardShim.get_eeg_channels(self.board_id) if BRAINFLOW_AVAILABLE else list(range(16))
        self.sampling_rate = BoardShim.get_sampling_rate(self.board_id) if BRAINFLOW_AVAILABLE else 125

    def list_available_ports(self):
        """Return serial ports currently visible on the host machine."""
        if not SERIAL_TOOLS_AVAILABLE:
            return []
        return [port.device for port in list_ports.comports()]

    def _build_port_candidates(self):
        """Prioritize configured port, then try other detected COM/tty ports."""
        candidates = []
        if self.serial_port:
            candidates.append(self.serial_port)

        for port in self.list_available_ports():
            if port not in candidates:
                candidates.append(port)

        return candidates

    def connect(self):
        """Prepare and start streaming from the board."""
        if not BRAINFLOW_AVAILABLE:
            raise RuntimeError(
                "BrainFlow is not installed. Run: pip install -r backend/requirements.txt"
            )

        candidates = self._build_port_candidates()
        errors = []

        for port in candidates:
            try:
                params = BrainFlowInputParams()
                params.serial_port = port
                board = BoardShim(self.board_id, params)
                board.prepare_session()
                board.start_stream()

                self.board = board
                self.serial_port = port
                self.connected = True
                logger.info(f"Cyton+Daisy connected on {self.serial_port} @ {self.sampling_rate} Hz")
                return
            except Exception as exc:
                errors.append(f"{port}: {exc}")
                logger.warning(f"OpenBCI connect failed on {port}: {exc}")

        available = self.list_available_ports()
        details = " | ".join(errors) if errors else "No candidate ports to try"
        raise RuntimeError(
            f"Unable to open OpenBCI serial port. Configured: {self.serial_port}. "
            f"Available: {available}. Attempts: {details}"
        )

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
