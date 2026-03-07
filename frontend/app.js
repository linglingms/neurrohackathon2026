const host = window.location.hostname || "localhost";
const params = new URLSearchParams(window.location.search);
const apiOverride = params.get("api");
const isLocalStatic = window.location.port === "8080" || host === "localhost" || host === "127.0.0.1";
const API_BASE_URL = apiOverride || (isLocalStatic ? `http://${host}:5050/api` : `${window.location.origin}/api`);
const LIVE_SAMPLE_INTERVAL_MS = 1000;
const MAX_TRANSCRIPT_ROWS = 160;

const state = {
    active: false,
    scores: [],
    lastResult: null,
    transcript: [],
    liveTimer: null,
    requestInFlight: false,
    sampleCount: 0,
    micEnabled: false,
    micListening: false,
    speechRecognition: null,
};

const el = {
    health: document.getElementById("health-pill"),
    micPill: document.getElementById("mic-pill"),
    startBtn: document.getElementById("start-btn"),
    sampleBtn: document.getElementById("sample-btn"),
    endBtn: document.getElementById("end-btn"),
    micBtn: document.getElementById("mic-btn"),
    exportBtn: document.getElementById("export-btn"),
    scoreValue: document.getElementById("score-value"),
    scoreBar: document.getElementById("score-bar"),
    statusText: document.getElementById("status-text"),
    windowsValue: document.getElementById("windows-value"),
    avgValue: document.getElementById("avg-value"),
    confidenceValue: document.getElementById("confidence-value"),
    reportBox: document.getElementById("report-box"),
    transcriptLog: document.getElementById("transcript-log"),
    micCaption: document.getElementById("mic-caption"),
};

function renderTranscript() {
    if (!state.transcript.length) {
        el.transcriptLog.innerHTML = '<div class="transcript-empty">Transcript will appear after the interview starts.</div>';
        return;
    }

    const headerCells = ["Role", "Node 1", "Node 2", "Node 3", "Node 4", "Node 5", "Node 6", "Node 7", "Node 8", "Overall Confidence"];
    const headerHtml = headerCells.map((label) => `<th>${label}</th>`).join("");

    const rowsHtml = state.transcript
        .map((entry) => {
            const nodeCells = entry.nodes
                .map((value) => `<td class="node-cell">${formatPercentCell(value)}</td>`)
                .join("");

            return [
                "<tr>",
                `<td><span class="speaker speaker-${entry.speaker.toLowerCase()}">${entry.speaker}</span></td>`,
                nodeCells,
                `<td class="confidence-cell">${formatPercentCell(entry.confidence)}</td>`,
                "</tr>",
            ].join("");
        })
        .join("");

    el.transcriptLog.innerHTML = [
        '<table class="transcript-table">',
        `<thead><tr>${headerHtml}</tr></thead>`,
        `<tbody>${rowsHtml}</tbody>`,
        "</table>",
    ].join("");

    el.transcriptLog.scrollTop = el.transcriptLog.scrollHeight;
}

function formatPercentCell(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    return `${Math.round(value)}%`;
}

function toPercent(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return null;
    }
    return Math.max(0, Math.min(100, value * 100));
}

function buildNodeStressPercentages(result) {
    if (Array.isArray(result.node_stress) && result.node_stress.length >= 8) {
        return result.node_stress.slice(0, 8).map((value) => toPercent(value));
    }

    if (Array.isArray(result.predictions) && result.predictions.length > 0) {
        const values = result.predictions;
        const chunkSize = Math.max(1, Math.floor(values.length / 8));
        const nodes = [];

        for (let i = 0; i < 8; i += 1) {
            const start = i * chunkSize;
            const end = i === 7 ? values.length : Math.min(values.length, start + chunkSize);
            const chunk = values.slice(start, end);

            if (!chunk.length) {
                nodes.push(toPercent(result.deception_probability || 0));
                continue;
            }

            const average = chunk.reduce((acc, value) => acc + value, 0) / chunk.length;
            nodes.push(toPercent(average));
        }

        return nodes;
    }

    const overallPct = toPercent(result.deception_probability || 0);
    return new Array(8).fill(overallPct);
}

function addTranscriptLine(speaker, text, metrics = null) {
    const nodes = metrics && Array.isArray(metrics.nodes) && metrics.nodes.length === 8
        ? metrics.nodes
        : new Array(8).fill(null);
    const confidence = metrics && typeof metrics.confidence === "number" ? metrics.confidence : null;

    state.transcript.push({ speaker, text, nodes, confidence });
    if (state.transcript.length > MAX_TRANSCRIPT_ROWS) {
        state.transcript = state.transcript.slice(-MAX_TRANSCRIPT_ROWS);
    }
    renderTranscript();
}

function stopLiveProcessing() {
    if (state.liveTimer) {
        clearInterval(state.liveTimer);
        state.liveTimer = null;
    }
}

function startLiveProcessing() {
    stopLiveProcessing();
    state.liveTimer = setInterval(() => {
        processSample(true).catch((error) => {
            el.statusText.textContent = `Live stream paused: ${error.message}`;
        });
    }, LIVE_SAMPLE_INTERVAL_MS);
}

function getLatestMetrics() {
    if (!state.lastResult) {
        return null;
    }

    return {
        nodes: buildNodeStressPercentages(state.lastResult),
        confidence: toPercent(state.lastResult.confidence || 0),
    };
}

function updateMicUi() {
    if (!el.micPill || !el.micBtn) {
        return;
    }

    if (!state.micEnabled) {
        el.micPill.textContent = "Mic: Off";
        el.micPill.className = "pill mic-pill";
        el.micBtn.textContent = "Enable Microphone";
        return;
    }

    if (state.micListening) {
        el.micPill.textContent = "Mic: Listening";
        el.micPill.className = "pill mic-pill mic-pill-on";
        el.micBtn.textContent = "Disable Microphone";
    } else {
        el.micPill.textContent = "Mic: Enabled";
        el.micPill.className = "pill mic-pill mic-pill-idle";
        el.micBtn.textContent = "Disable Microphone";
    }
}

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
        state.micListening = true;
        updateMicUi();
    };

    recognition.onend = () => {
        state.micListening = false;
        updateMicUi();

        // Resume listening while active unless the user manually turned mic off.
        if (state.active && state.micEnabled) {
            setTimeout(() => {
                try {
                    recognition.start();
                } catch (error) {
                    // Ignore double-start timing races; browser will continue firing onend.
                }
            }, 150);
        }
    };

    recognition.onerror = (event) => {
        el.statusText.textContent = `Microphone error: ${event.error}`;
    };

    recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const text = event.results[i][0].transcript.trim();
            if (event.results[i].isFinal) {
                const metrics = getLatestMetrics();
                el.micCaption.textContent = `Mic transcript: ${text}`;
                addTranscriptLine("Interviewee", `Mic: ${text}`, metrics);
            } else {
                interim = text;
            }
        }

        if (interim) {
            el.micCaption.textContent = `Mic transcript (listening): ${interim}`;
        }
    };

    return recognition;
}

async function enableMic() {
    if (state.micEnabled) {
        return;
    }

    if (!state.speechRecognition) {
        state.speechRecognition = initSpeechRecognition();
    }
    if (!state.speechRecognition) {
        throw new Error("Speech recognition is not supported in this browser");
    }

    // Ask for microphone permission before starting recognition.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone API not available in this browser");
    }

    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    media.getTracks().forEach((track) => track.stop());

    state.micEnabled = true;
    updateMicUi();

    if (state.active) {
        try {
            state.speechRecognition.start();
        } catch (error) {
            // Ignore duplicate starts if recognition is already running.
        }
    }
}

function disableMic() {
    state.micEnabled = false;
    state.micListening = false;
    if (state.speechRecognition) {
        state.speechRecognition.onend = null;
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op if recognition is not active.
        }
        state.speechRecognition = initSpeechRecognition();
    }
    el.micCaption.textContent = "Mic transcript: waiting...";
    updateMicUi();
}

async function toggleMic() {
    if (state.micEnabled) {
        disableMic();
        return;
    }
    await enableMic();
}

function updateButtons() {
    el.startBtn.disabled = state.active;
    el.sampleBtn.disabled = !state.active;
    el.endBtn.disabled = !state.active;
    el.exportBtn.disabled = state.active;
    el.micBtn.disabled = false;
}

function updateSummary(result) {
    const scorePct = Math.round((result.deception_probability || 0) * 100);
    const confidencePct = Math.round((result.confidence || 0) * 100);
    const avg = state.scores.length
        ? Math.round((state.scores.reduce((a, b) => a + b, 0) / state.scores.length) * 100)
        : 0;

    el.scoreValue.textContent = `${scorePct}%`;
    el.scoreBar.style.width = `${scorePct}%`;
    el.scoreBar.textContent = `${scorePct}%`;
    el.windowsValue.textContent = String(state.scores.length);
    el.avgValue.textContent = `${avg}%`;
    el.confidenceValue.textContent = `${confidencePct}%`;

    el.statusText.textContent = result.is_deceptive
        ? "Likely elevated cognitive stress"
        : "Likely lower cognitive stress";
}

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
    });
    if (!response.ok) {
        throw new Error(`Request failed: ${path}`);
    }
    return response.json();
}

async function checkHealth() {
    try {
        await api("/health");
        el.health.textContent = "API Online";
        el.health.className = "pill pill-ok";
    } catch (error) {
        el.health.textContent = "API Offline";
        el.health.className = "pill pill-bad";
    }
}

async function startSession() {
    let hardwareMessage = "";
    try {
        const hardware = await api("/hardware/connect", { method: "POST" });
        if (hardware && (hardware.status === "connected" || hardware.status === "already_connected")) {
            hardwareMessage = `Hardware: ${hardware.status.replace("_", " ")}`;
        }
    } catch (error) {
        hardwareMessage = "Hardware unavailable, using mock EEG data";
    }

    await api("/session/start", { method: "POST" });
    state.active = true;
    state.scores = [];
    state.lastResult = null;
    state.transcript = [];
    state.sampleCount = 0;
    state.requestInFlight = false;
    el.reportBox.textContent = hardwareMessage
        ? `Session started. ${hardwareMessage}. Run one or more samples.`
        : "Session started. Run one or more samples.";
    el.statusText.textContent = "Collecting baseline...";
    addTranscriptLine("Interviewer", "Interview has started. Please introduce yourself.");
    addTranscriptLine("Interviewee", "Hello, I am ready to begin the interview.");
    updateButtons();
    startLiveProcessing();
    if (state.micEnabled && state.speechRecognition) {
        try {
            state.speechRecognition.start();
        } catch (error) {
            // Ignore duplicate starts when already listening.
        }
    }
    el.statusText.textContent = "Live monitoring active";
}

async function processSample(isLiveMode = false) {
    if (!state.active || state.requestInFlight) {
        return;
    }

    state.requestInFlight = true;
    try {
        const result = await api("/session/process", {
            method: "POST",
            body: JSON.stringify({}),
        });
        state.lastResult = result;
        state.scores.push(result.deception_probability || 0);
        state.sampleCount += 1;
        const scorePct = Math.round((result.deception_probability || 0) * 100);
        const metrics = {
            nodes: buildNodeStressPercentages(result),
            confidence: toPercent(result.confidence || 0),
        };

        if (!isLiveMode || state.sampleCount % 4 === 1) {
            addTranscriptLine("Interviewer", "Please continue with your response.", metrics);
        }
        addTranscriptLine("Interviewee", `Live sample ${state.sampleCount}: stress marker ${scorePct}%.`, metrics);

        updateSummary(result);
    } finally {
        state.requestInFlight = false;
    }
}

async function runSample() {
    await processSample(false);
}

async function endSession() {
    stopLiveProcessing();
    if (state.speechRecognition && state.micListening) {
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op if recognition is already stopped.
        }
    }
    const report = await api("/session/end", { method: "POST" });
    state.active = false;
    state.requestInFlight = false;
    updateButtons();
    addTranscriptLine("Interviewer", "Thank you. This concludes the interview.");
    addTranscriptLine("Interviewee", "Thank you for your time.");
    el.reportBox.innerHTML = [
        `Total windows: ${report.total_windows}`,
        `Deceptive windows: ${report.deceptive_windows}`,
        `Average probability: ${(report.average_deception_probability * 100).toFixed(1)}%`,
        `Assessment: ${report.session_assessment}`,
    ].join("<br>");
}

async function exportSession() {
    const exported = await api("/session/export", { method: "POST" });
    el.reportBox.innerHTML = [
        `Export status: ${exported.status}`,
        `Saved file: ${exported.file}`,
        `Entries: ${exported.entries}`,
    ].join("<br>");
}

el.startBtn.addEventListener("click", () => startSession().catch((e) => (el.statusText.textContent = e.message)));
el.sampleBtn.addEventListener("click", () => runSample().catch((e) => (el.statusText.textContent = e.message)));
el.endBtn.addEventListener("click", () => endSession().catch((e) => (el.statusText.textContent = e.message)));
el.micBtn.addEventListener("click", () => toggleMic().catch((e) => (el.statusText.textContent = e.message)));
el.exportBtn.addEventListener("click", () => exportSession().catch((e) => (el.statusText.textContent = e.message)));
window.addEventListener("beforeunload", () => {
    stopLiveProcessing();
    if (state.speechRecognition && state.micListening) {
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op on unload.
        }
    }
});

updateButtons();
updateMicUi();
renderTranscript();
checkHealth();
