const host = window.location.hostname || "localhost";
const params = new URLSearchParams(window.location.search);
const apiOverrideRaw = params.get("api");
// "?api=live" uses the Vercel proxy route to avoid ngrok interstitial/CORS issues.
const apiOverride = apiOverrideRaw === "live" ? `${window.location.origin}/live-api` : apiOverrideRaw;
const isLiveOverride = !!apiOverride;
const isLocalStatic = window.location.port === "8080" || host === "localhost" || host === "127.0.0.1";

function normalizeApiBase(url) {
    if (!url) {
        return null;
    }

    const trimmed = url.trim();

    // Accept both API base URLs and accidentally pasted endpoint URLs.
    // Examples handled:
    // - https://host
    // - https://host/api
    // - https://host/api/health
    // - https://host/api/session/status
    try {
        const parsed = new URL(trimmed);
        const apiMatch = parsed.pathname.match(/^(.*?\/api)(?:\/.*)?\/?$/i);
        parsed.pathname = apiMatch ? apiMatch[1] : `${parsed.pathname.replace(/\/+$/, "")}/api`;
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString().replace(/\/+$/, "");
    } catch (error) {
        // Fallback for non-standard values; keep behavior predictable.
        const normalized = trimmed.replace(/\/+$/, "");
        const apiMatch = normalized.match(/^(.*?\/api)(?:\/.*)?$/i);
        return apiMatch ? apiMatch[1] : `${normalized}/api`;
    }
}

const API_BASE_URL = normalizeApiBase(apiOverride) || (isLocalStatic ? `http://${host}:5050/api` : `${window.location.origin}/api`);
let activeApiBaseUrl = API_BASE_URL;
const SOCKET_URL = API_BASE_URL.replace(/\/api\/?$/, "");
const NGROK_HOST_PATTERN = /(^|\.)ngrok-free\.app$|(^|\.)ngrok\.io$/i;
const MAX_TRANSCRIPT_ROWS = 160;
const EEG_CAPTURE_INTERVAL_MS = 1000;
const STATUS_REFRESH_INTERVAL_MS = 5000;
const TRANSCRIPT_VISUALIZATION_OPTIONS = [
    "time series",
    "fft plot",
    "accelerometer",
    "cyton signal",
    "focus widget",
    "network",
    "band power",
    "head plot",
    "EMG",
    "EMG joystick",
    "spectrogram",
    "pulse",
    "digital read",
    "analog read",
    "packet loss",
    "marker",
];

const state = {
    active: false,
    scores: [],
    lastResult: null,
    transcript: [],
    selectedTranscriptRow: null,
    requestInFlight: false,
    micEnabled: false,
    micListening: false,
    speechRecognition: null,
    lastAssignedRole: null,
    dataSource: "unknown",
    eegTimer: null,
    hardwareConnected: false,
    hardwareSource: null,
    openbciConnected: false,
    lslConnected: false,
    lslStreamName: null,
    sessionActive: false,
    sessionStartedAt: null,
    speechTurnStartedAt: null,
    apiOnline: false,
    hardwarePort: null,
    hardwareError: null,
    liveVisualization: TRANSCRIPT_VISUALIZATION_OPTIONS[0],
    liveNodeIndex: 0,
    liveNodeHistory: Array.from({ length: 8 }, () => []),
    socketConnected: false,
    lslActive: false,
    hasExportableData: false,
};

const el = {
    health: document.getElementById("health-pill"),
    apiBaseLabel: document.getElementById("api-base-label"),
    headsetStatus: document.getElementById("headset-status"),
    lslStatus: document.getElementById("lsl-status"),
    openbciStatus: document.getElementById("openbci-status"),
    micPill: document.getElementById("mic-pill"),
    hwPill: document.getElementById("hw-pill"),
    hwBar: document.getElementById("hw-bar"),
    hwIcon: document.getElementById("hw-icon"),
    hwMessage: document.getElementById("hw-message"),
    hwConnectBtn: document.getElementById("hw-connect-btn"),
    hwDisconnectBtn: document.getElementById("hw-disconnect-btn"),
    portSelect: document.getElementById("port-select"),
    sourceSelect: document.getElementById("source-select"),
    modeHelpText: document.getElementById("mode-help-text"),
    mockWarning: document.getElementById("mock-warning"),
    startBtn: document.getElementById("start-btn"),
    sampleBtn: document.getElementById("sample-btn"),
    endBtn: document.getElementById("end-btn"),
    clearBtn: document.getElementById("clear-btn"),
    micBtn: document.getElementById("mic-btn"),
    speakerMode: document.getElementById("speaker-mode"),
    exportBtn: document.getElementById("export-btn"),
    scoreValue: document.getElementById("score-value"),
    scoreBar: document.getElementById("score-bar"),
    statusText: document.getElementById("status-text"),
    windowsValue: document.getElementById("windows-value"),
    avgValue: document.getElementById("avg-value"),
    confidenceValue: document.getElementById("confidence-value"),
    reportBox: document.getElementById("report-box"),
    transcriptLog: document.getElementById("transcript-log"),
    transcriptGraphTitle: document.getElementById("transcript-graph-title"),
    transcriptGraphBody: document.getElementById("transcript-graph-body"),
    liveGraphTitle: document.getElementById("live-graph-title"),
    liveGraphStatus: document.getElementById("live-graph-status"),
    liveGraphBars: document.getElementById("live-graph-bars"),
    liveGraphSelect: document.getElementById("live-graph-select"),
    liveNodePicker: document.getElementById("live-node-picker"),
    micCaption: document.getElementById("mic-caption"),
    sentimentRankingBody: document.getElementById("sentiment-ranking-body"),
};

const LIVE_NODE_HISTORY_LIMIT = 24;

function buildGraphBars(values, barClass = "graph-bar") {
    return values
        .map((value, idx) => {
            const height = Math.max(6, Math.round(value));
            return `<div class="graph-bar-wrap"><span class="graph-bar-label">N${idx + 1}</span><div class="${barClass}" style="height:${height}%"></div></div>`;
        })
        .join("");
}

function renderLiveGraph() {
    if (!el.liveGraphTitle || !el.liveGraphStatus || !el.liveGraphBars) {
        return;
    }

    const selectedView = state.liveVisualization || TRANSCRIPT_VISUALIZATION_OPTIONS[0];
    const selectedNode = state.liveNodeIndex + 1;
    const activeLiveSession = state.active && (state.dataSource === "openbci" || state.dataSource === "live_lsl");
    const nodeHistory = Array.isArray(state.liveNodeHistory[state.liveNodeIndex])
        ? state.liveNodeHistory[state.liveNodeIndex]
        : [];
    const hasNodeHistory = nodeHistory.length > 0;

    el.liveGraphTitle.textContent = activeLiveSession
        ? `Live OpenBCI Graph: ${selectedView} (Node ${selectedNode})`
        : `Live OpenBCI Graph (Pre-Start): ${selectedView} (Node ${selectedNode})`;

    if (el.liveNodePicker) {
        const buttons = el.liveNodePicker.querySelectorAll(".live-node-btn");
        buttons.forEach((button) => {
            const index = Number(button.getAttribute("data-node-index"));
            button.classList.toggle("is-active", index === state.liveNodeIndex);
        });
    }

    if (!activeLiveSession || !hasNodeHistory) {
        el.liveGraphStatus.textContent = activeLiveSession
            ? `Session active. Waiting for Node ${selectedNode} EEG window...`
            : "Waiting for active session and OpenBCI/LSL EEG.";
        el.liveGraphBars.innerHTML = '<div class="live-single-graph-empty">No live node data yet.</div>';
        return;
    }

    const trendBars = nodeHistory
        .map((value, idx) => {
            const normalized = typeof value === "number" && !Number.isNaN(value) ? value : 0;
            const height = Math.max(4, Math.round(normalized));
            return `<div class="live-trend-bar-wrap"><div class="live-trend-bar" style="height:${height}%" title="Sample ${idx + 1}: ${Math.round(normalized)}%"></div></div>`;
        })
        .join("");

    const latest = nodeHistory[nodeHistory.length - 1] || 0;
    el.liveGraphStatus.textContent = `Live Node ${selectedNode}: ${Math.round(latest)}% (${nodeHistory.length} samples)`;
    el.liveGraphBars.innerHTML = `<div class="live-trend-grid">${trendBars}</div>`;
}

function updateLiveNodeHistory(result) {
    const values = buildNodeStressPercentages(result).map((value) => (typeof value === "number" && !Number.isNaN(value) ? value : 0));
    for (let i = 0; i < 8; i += 1) {
        const bucket = state.liveNodeHistory[i] || [];
        bucket.push(values[i] || 0);
        if (bucket.length > LIVE_NODE_HISTORY_LIMIT) {
            bucket.shift();
        }
        state.liveNodeHistory[i] = bucket;
    }
}

function setApiBaseLabel(baseUrl, online) {
    if (!el.apiBaseLabel) {
        return;
    }

    if (online) {
        el.apiBaseLabel.textContent = `API Base: ${baseUrl}`;
        el.apiBaseLabel.style.color = "#7ef2d4";
        return;
    }

    el.apiBaseLabel.textContent = `API Base: offline (last tried ${baseUrl})`;
    el.apiBaseLabel.style.color = "#ffbcbc";
}

// ---------------------------------------------------------------------------
// Socket.IO connection -- real-time EEG scores + hardware status from backend
// ---------------------------------------------------------------------------
let socket = null;

function initSocket() {
    if (typeof io === "undefined") {
        console.warn("Socket.IO client not loaded -- falling back to HTTP polling");
        return;
    }

    socket = io(SOCKET_URL, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity,
        extraHeaders: { "ngrok-skip-browser-warning": "true" },
    });

    socket.on("connect", () => {
        state.socketConnected = true;
        console.log("Socket.IO connected to", SOCKET_URL);
    });

    socket.on("disconnect", () => {
        state.socketConnected = false;
        console.warn("Socket.IO disconnected");
    });

    // Real-time scored EEG data pushed from LSL consumer on the backend
    socket.on("eeg_score", (result) => {
        if (!state.active) return;

        state.lastResult = result;
        state.scores.push(result.deception_probability || 0);

        if (result.data_source === "mock") {
            el.mockWarning.style.display = "";
        } else {
            el.mockWarning.style.display = "none";
        }

        if (result.data_source === "lsl") {
            state.dataSource = "openbci";
            state.lslActive = true;
        }

        updateSummary(result);
    });

    // Hardware connection status updates (LSL stream found/lost, direct serial)
    socket.on("hardware_status", (data) => {
        const connected = !!data.connected;
        state.hardwareConnected = connected;

        const source = data.source || "none";
        const port = data.stream_name || data.port || null;

        if (source === "lsl") {
            state.lslActive = true;
            state.dataSource = "openbci";
        } else if (source === "direct") {
            state.dataSource = "openbci";
        }

        updateHardwareUI(connected, port);
        updateConnectionStatus();
    });

    // Session status updates (start/end from another client or the backend)
    socket.on("session_status", (data) => {
        state.sessionActive = !!data.active;
        updateConnectionStatus();
    });
}

initSocket();

function setHeadsetStatus(connected) {
    if (!el.headsetStatus) {
        return;
    }

    const label = connected ? "Connected" : "Disconnected";
    const statusClass = connected ? "status-word status-word-ok" : "status-word status-word-bad";
    el.headsetStatus.innerHTML = `Headset: <span class="${statusClass}">${label}</span>`;
}

function setOpenBciStatus(connected) {
    if (!el.openbciStatus) {
        return;
    }

    const label = connected ? "Connected" : "Disconnected";
    const statusClass = connected ? "status-word status-word-ok" : "status-word status-word-bad";
    el.openbciStatus.innerHTML = `OpenBCI: <span class="${statusClass}">${label}</span>`;
}

function setLslStatus(connected, streamName = null) {
    if (!el.lslStatus) {
        return;
    }

    const label = connected ? `Connected${streamName ? ` (${streamName})` : ""}` : "Disconnected";
    const statusClass = connected ? "status-word status-word-ok" : "status-word status-word-bad";
    el.lslStatus.innerHTML = `LSL: <span class="${statusClass}">${label}</span>`;
}

function updateConnectionStatus() {
    setHeadsetStatus(!!state.hardwareConnected);
    setLslStatus(!!state.lslConnected, state.lslStreamName);
    setOpenBciStatus(!!state.openbciConnected);
}

function getSelectedSourceMode() {
    return (el.sourceSelect && el.sourceSelect.value) || "auto";
}

function getStartReadiness() {
    const sourceMode = getSelectedSourceMode();
    const lslConnected = !!state.lslConnected;
    const openbciConnected = !!state.openbciConnected;
    const sourceReady = sourceMode === "lsl"
        ? lslConnected
        : (sourceMode === "serial" ? openbciConnected : (lslConnected || openbciConnected));

    return {
        micOn: !!state.micEnabled,
        apiOn: !!state.apiOnline,
        headsetConnected: !!state.hardwareConnected,
        lslConnected,
        openbciConnected,
        sourceMode,
        sourceReady,
    };
}

function canStartInterview() {
    const readiness = getStartReadiness();
    return readiness.micOn
        && readiness.apiOn
        && readiness.headsetConnected
        && readiness.sourceReady;
}

function buildPreflightMessage() {
    const readiness = getStartReadiness();
    const missing = [];

    if (!readiness.micOn) missing.push("Mic ON");
    if (!readiness.apiOn) missing.push("API Online");
    if (!readiness.headsetConnected) missing.push("Headset Connected");
    if (!readiness.sourceReady) {
        if (readiness.sourceMode === "lsl") {
            missing.push("LSL Connected");
        } else if (readiness.sourceMode === "serial") {
            missing.push("OpenBCI Connected");
        } else {
            missing.push("LSL or OpenBCI Connected");
        }
    }

    return missing.length ? `Start locked. Missing: ${missing.join(", ")}` : null;
}

function updateSourceModeUi() {
    if (!el.sourceSelect || !el.modeHelpText || !el.portSelect) {
        return;
    }

    const mode = el.sourceSelect.value;
    if (mode === "lsl") {
        el.modeHelpText.textContent = "LSL mode selected: OpenBCI/LSL app must be open and actively streaming.";
        el.portSelect.disabled = true;
        updateButtons();
        return;
    }

    if (mode === "serial") {
        el.modeHelpText.textContent = "Serial mode selected: close OpenBCI GUI/LSL app before connecting to COM port.";
        el.portSelect.disabled = false;
        updateButtons();
        return;
    }

    el.modeHelpText.textContent = "Auto mode selected: backend tries LSL first, then serial port fallback.";
    el.portSelect.disabled = false;
    updateButtons();
}

function renderTranscript() {
    const headerCells = ["View", "Role", "Timestamp", "1", "2", "3", "4", "5", "6", "7", "8"];
    const headerHtml = headerCells.map((label) => `<th>${label}</th>`).join("");

    if (!state.transcript.length) {
        const emptyToken = state.active
            ? "&nbsp;"
            : '<span class="transcript-placeholder">--</span>';

        const previewRows = new Array(5)
            .fill(null)
            .map((_, index) => [
                `<tr data-preview-row="${index}">`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                `<td class="transcript-placeholder-cell">${emptyToken}</td>`,
                "</tr>",
            ].join(""))
            .join("");

        el.transcriptLog.innerHTML = [
            '<table class="transcript-table transcript-table-preview">',
            `<thead><tr>${headerHtml}</tr></thead>`,
            `<tbody>${previewRows}</tbody>`,
            "</table>",
        ].join("");

        setTranscriptPreviewWindow();
        el.transcriptLog.scrollTop = 0;
        renderTranscriptGraph();
        renderSentimentRankingAnalysis();
        return;
    }

    if (state.selectedTranscriptRow === null || state.selectedTranscriptRow >= state.transcript.length) {
        const latestWithEeg = state.transcript
            .map((entry, idx) => ({ entry, idx }))
            .reverse()
            .find(({ entry }) => Array.isArray(entry.nodes) && entry.nodes.some((value) => typeof value === "number" && !Number.isNaN(value)));
        state.selectedTranscriptRow = latestWithEeg ? latestWithEeg.idx : Math.max(0, state.transcript.length - 1);
    }

    const rowsHtml = state.transcript
        .map((entry, index) => {
            const nodeCells = entry.nodes
                .map((value) => `<td class="node-cell">${formatPercentCell(value)}</td>`)
                .join("");

            const selectedOption = entry.visualization || TRANSCRIPT_VISUALIZATION_OPTIONS[0];
            const optionHtml = TRANSCRIPT_VISUALIZATION_OPTIONS
                .map((opt) => `<option value="${opt}"${opt === selectedOption ? " selected" : ""}>${opt}</option>`)
                .join("");

            return [
                `<tr class="${index === state.selectedTranscriptRow ? "transcript-row-active" : ""}" data-row-index="${index}">`,
                `<td><select class="transcript-view-select" data-row-index="${index}">${optionHtml}</select></td>`,
                `<td><span class="speaker speaker-${entry.speaker.toLowerCase()}">${entry.speaker}</span></td>`,
                `<td class="timestamp-cell" title="${entry.timeframe}"><div class="timestamp-main">${entry.timestamp}</div><div class="timestamp-sub">${entry.timeframe}</div></td>`,
                nodeCells,
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

    setTranscriptPreviewWindow();
    // Keep the preview focused on the first five rows.
    el.transcriptLog.scrollTop = 0;
    renderTranscriptGraph();
    renderLiveGraph();
    renderSentimentRankingAnalysis();
}

function setTranscriptPreviewWindow() {
    if (!el.transcriptLog) {
        return;
    }

    // Keep transcript area scrollable regardless of row count.
    el.transcriptLog.style.overflowY = "auto";
    el.transcriptLog.style.overflowX = "auto";

    const table = el.transcriptLog.querySelector(".transcript-table");
    if (!(table instanceof HTMLTableElement)) {
        el.transcriptLog.style.height = "";
        el.transcriptLog.style.maxHeight = "";
        return;
    }

    const header = table.querySelector("thead");
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    const visibleRows = rows.slice(0, 5);

    if (!visibleRows.length) {
        el.transcriptLog.style.height = "";
        el.transcriptLog.style.maxHeight = "";
        return;
    }

    const headerHeight = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    const rowsHeight = visibleRows.reduce((sum, row) => sum + Math.ceil(row.getBoundingClientRect().height), 0);
    const viewportHeight = Math.max(160, headerHeight + rowsHeight + 4);

    el.transcriptLog.style.height = `${viewportHeight}px`;
    el.transcriptLog.style.maxHeight = `${viewportHeight}px`;
}

function renderTranscriptGraph() {
    if (!el.transcriptGraphTitle || !el.transcriptGraphBody) {
        return;
    }

    if (!state.transcript.length || state.selectedTranscriptRow === null) {
        const previewBars = getBlankGraphBars()
            .map((barHtml, idx) => {
                return `<div class="graph-bar-wrap"><span class="graph-bar-label">N${idx + 1}</span>${barHtml}</div>`;
            })
            .join("");

        el.transcriptGraphTitle.textContent = "Interviewee Graph Preview (Pre-Start)";
        el.transcriptGraphBody.innerHTML = [
            '<div class="transcript-preview-note">Awaiting live interviewee EEG data.</div>',
            `<div class="transcript-graph-bars">${previewBars}</div>`,
        ].join("");
        return;
    }

    const row = state.transcript[state.selectedTranscriptRow];
    if (!row) {
        return;
    }

    const hasNodeData = Array.isArray(row.nodes) && row.nodes.some((value) => typeof value === "number" && !Number.isNaN(value));
    const bars = hasNodeData
        ? buildGraphBars(
            row.nodes.map((value) => (typeof value === "number" && !Number.isNaN(value) ? value : 0)),
            "graph-bar",
        )
        : getBlankGraphBars()
            .map((barHtml, idx) => `<div class="graph-bar-wrap"><span class="graph-bar-label">N${idx + 1}</span>${barHtml}</div>`)
            .join("");

    el.transcriptGraphTitle.textContent = hasNodeData
        ? `Row ${state.selectedTranscriptRow + 1}: ${row.speaker} - ${row.visualization || TRANSCRIPT_VISUALIZATION_OPTIONS[0]}`
        : `Row ${state.selectedTranscriptRow + 1}: ${row.speaker} - No EEG Yet`;
    el.transcriptGraphBody.innerHTML = hasNodeData
        ? `<div class="transcript-graph-bars">${bars}</div>`
        : [
            '<div class="transcript-preview-note">No EEG values for this turn yet.</div>',
            `<div class="transcript-graph-bars">${bars}</div>`,
        ].join("");
}

function getBlankGraphBars() {
    return new Array(8).fill('<div class="graph-bar graph-bar-empty"></div>');
}

function formatTurnTimestamp(timestampMs) {
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
        return "--:--:--";
    }
    return date.toLocaleTimeString([], { hour12: false });
}

function formatElapsed(elapsedMs) {
    if (typeof elapsedMs !== "number" || Number.isNaN(elapsedMs) || elapsedMs < 0) {
        return "--:--";
    }
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function formatSeconds(seconds) {
    if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds < 0) {
        return "--.-s";
    }
    return `${seconds.toFixed(1)}s`;
}

function buildTurnTimeframe(turnStartedAt, turnEndedAt) {
    const start = typeof turnStartedAt === "number" ? turnStartedAt : turnEndedAt;
    const sessionStart = typeof state.sessionStartedAt === "number" ? state.sessionStartedAt : start;
    const sessionElapsed = formatElapsed(start - sessionStart);
    const durationSeconds = formatSeconds((turnEndedAt - start) / 1000);
    return `+${sessionElapsed} | ${durationSeconds}`;
}

function formatPercentCell(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    return `${Math.round(value)}%`;
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function toPercent(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return null;
    }
    return Math.max(0, Math.min(100, value * 100));
}

function classifySpeaker(rawText) {
    const mode = el.speakerMode ? el.speakerMode.value : "auto";
    if (mode === "interviewer") {
        return "Interviewer";
    }
    if (mode === "interviewee") {
        return "Interviewee";
    }

    const text = (rawText || "").trim();
    const lower = text.toLowerCase();

    if (lower.startsWith("interviewer:") || lower.startsWith("question:")) {
        return "Interviewer";
    }
    if (lower.startsWith("interviewee:") || lower.startsWith("candidate:") || lower.startsWith("answer:")) {
        return "Interviewee";
    }

    const questionStarters = [
        "can you", "could you", "would you", "will you", "what", "why", "how", "when", "where", "who", "tell me", "describe", "explain",
    ];
    const answerStarters = [
        "i ", "my ", "in my", "we ", "our ", "yes", "no", "because", "sure", "absolutely", "honestly",
    ];
    const looksLikeQuestion = text.endsWith("?") || questionStarters.some((prefix) => lower.startsWith(prefix));
    const looksLikeAnswer = answerStarters.some((prefix) => lower.startsWith(prefix));

    if (looksLikeQuestion) {
        return "Interviewer";
    }
    if (looksLikeAnswer) {
        return "Interviewee";
    }

    // Fallback to conversational turn taking when auto mode is uncertain.
    if (state.lastAssignedRole === "Interviewer") {
        return "Interviewee";
    }
    if (state.lastAssignedRole === "Interviewee") {
        return "Interviewer";
    }

    return "Interviewer";
}

function normalizeTranscriptText(rawText) {
    return (rawText || "")
        .replace(/^\s*(interviewer|question|interviewee|candidate|answer)\s*:\s*/i, "")
        .trim();
}

function shouldScoreUtterance(speaker) {
    if (speaker !== "Interviewee") return false;
    // When LSL is active, metrics arrive via Socket.IO -- use latest cached result
    // instead of triggering an HTTP request.
    if (state.lslActive && state.socketConnected) return false;
    return state.dataSource === "openbci" || state.dataSource === "live_lsl";
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

function addTranscriptLine(speaker, text, metrics = null, timing = null) {
    const nodes = metrics && Array.isArray(metrics.nodes) && metrics.nodes.length === 8
        ? metrics.nodes
        : new Array(8).fill(null);
    const confidence = metrics && typeof metrics.confidence === "number" ? metrics.confidence : null;
    const stress = metrics && typeof metrics.stress === "number" ? metrics.stress : null;

    const turnEndedAt = timing && typeof timing.turnEndedAt === "number"
        ? timing.turnEndedAt
        : Date.now();
    const turnStartedAt = timing && typeof timing.turnStartedAt === "number"
        ? timing.turnStartedAt
        : turnEndedAt;

    state.transcript.push({
        speaker,
        text,
        nodes,
        stress,
        confidence,
        timestamp: formatTurnTimestamp(turnEndedAt),
        timeframe: buildTurnTimeframe(turnStartedAt, turnEndedAt),
        visualization: TRANSCRIPT_VISUALIZATION_OPTIONS[0],
    });
    state.lastAssignedRole = speaker;
    if (state.transcript.length > MAX_TRANSCRIPT_ROWS) {
        state.transcript = state.transcript.slice(-MAX_TRANSCRIPT_ROWS);
    }
    state.selectedTranscriptRow = Math.max(0, state.transcript.length - 1);
    renderTranscript();
}

function getLatestMetrics() {
    if (!state.lastResult) {
        return null;
    }

    return {
        nodes: buildNodeStressPercentages(state.lastResult),
        stress: toPercent(state.lastResult.deception_probability || 0),
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
        updateButtons();
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

    updateButtons();
}

function stopEegCapture() {
    if (state.eegTimer) {
        clearInterval(state.eegTimer);
        state.eegTimer = null;
    }
}

async function captureEegWindow() {
    if (!state.active || (state.dataSource !== "openbci" && state.dataSource !== "live_lsl") || state.requestInFlight) {
        return;
    }

    try {
        await scoreUtterance();
    } catch (error) {
        el.statusText.textContent = `EEG capture error: ${error.message}`;
    }
}

function startEegCapture() {
    stopEegCapture();

    // When LSL + Socket.IO is active, the backend pushes scores in real time
    // -- no need for HTTP polling.
    if (state.lslActive && state.socketConnected) {
        console.log("EEG capture: using real-time Socket.IO/LSL (no HTTP polling)");
        return;
    }

    if (state.dataSource !== "openbci" && state.dataSource !== "live_lsl") {
        return;
    }

    state.eegTimer = setInterval(() => {
        captureEegWindow();
    }, EEG_CAPTURE_INTERVAL_MS);
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
                const turnEndedAt = Date.now();
                const turnStartedAt = state.speechTurnStartedAt || turnEndedAt;
                const cleanedText = normalizeTranscriptText(text);
                const speaker = classifySpeaker(text);
                el.micCaption.textContent = `Mic transcript: ${cleanedText}`;

                if (!shouldScoreUtterance(speaker)) {
                    // When LSL is active, attach the latest real-time metrics
                    // to interviewee lines instead of leaving them blank.
                    const lslMetrics = (speaker === "Interviewee" && state.lslActive && state.socketConnected)
                        ? getLatestMetrics()
                        : null;
                    addTranscriptLine(speaker, cleanedText, lslMetrics, { turnStartedAt, turnEndedAt });
                    if (speaker === "Interviewer") {
                        el.statusText.textContent = "Interviewer speech captured; scores update only from interviewee OpenBCI data.";
                    } else if (state.lslActive && state.socketConnected) {
                        el.statusText.textContent = "Interviewee speech captured with live LSL EEG data.";
                    } else if (state.dataSource !== "openbci" && state.dataSource !== "live_lsl") {
                        el.statusText.textContent = "Interviewee speech captured, waiting for OpenBCI data source.";
                    }
                    state.speechTurnStartedAt = null;
                    continue;
                }

                const metrics = getLatestMetrics();
                if (metrics) {
                    addTranscriptLine(speaker, cleanedText, metrics, { turnStartedAt, turnEndedAt });
                    state.speechTurnStartedAt = null;
                } else {
                    scoreUtterance()
                        .then((freshMetrics) => {
                            addTranscriptLine(speaker, cleanedText, freshMetrics, { turnStartedAt, turnEndedAt });
                            state.speechTurnStartedAt = null;
                        })
                        .catch((error) => {
                            el.statusText.textContent = `Scoring error: ${error.message}`;
                            addTranscriptLine(speaker, cleanedText, null, { turnStartedAt, turnEndedAt });
                            state.speechTurnStartedAt = null;
                        });
                }
            } else {
                interim = text;
                if (interim && !state.speechTurnStartedAt) {
                    state.speechTurnStartedAt = Date.now();
                }
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
    el.startBtn.disabled = state.active || !canStartInterview();
    el.sampleBtn.disabled = true;
    el.endBtn.disabled = !state.active;
    const clearAllowed = !state.active && hasSessionDataForExport();
    if (el.clearBtn) {
        el.clearBtn.disabled = !clearAllowed;
    }
    const exportAllowed = !state.active
        && el.startBtn.disabled
        && el.endBtn.disabled
        && state.hasExportableData;
    el.exportBtn.disabled = !exportAllowed;
    el.micBtn.disabled = false;

    if (!state.active && el.statusText) {
        const preflight = buildPreflightMessage();
        if (preflight) {
            el.statusText.textContent = preflight;
        }
    }
}

function hasSessionDataForExport() {
    const hasScores = Array.isArray(state.scores) && state.scores.length > 0;
    const hasTranscript = Array.isArray(state.transcript) && state.transcript.length > 0;
    return hasScores || hasTranscript;
}

function buildClientExportPayload(serverExport = null) {
    return {
        exported_at: new Date().toISOString(),
        session: {
            active: state.active,
            started_at: state.sessionStartedAt ? new Date(state.sessionStartedAt).toISOString() : null,
            data_source: state.dataSource,
            hardware_connected: state.hardwareConnected,
            hardware_source: state.hardwareSource,
            lsl_connected: state.lslConnected,
            lsl_stream_name: state.lslStreamName,
        },
        summary: {
            total_windows: state.scores.length,
            average_score: state.scores.length
                ? state.scores.reduce((a, b) => a + b, 0) / state.scores.length
                : 0,
            latest_result: state.lastResult,
        },
        transcript: state.transcript,
        scores: state.scores,
        backend_export: serverExport,
    };
}

function downloadJsonFile(payload, filenamePrefix = "session_export") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${filenamePrefix}_${stamp}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

function clearAll() {
    const clearAllowed = !state.active && hasSessionDataForExport();
    if (!clearAllowed) {
        el.statusText.textContent = "Clear All is available only when interview is not active and there is data to clear.";
        return;
    }

    stopEegCapture();

    state.active = false;
    state.sessionActive = false;
    state.scores = [];
    state.lastResult = null;
    state.transcript = [];
    state.selectedTranscriptRow = null;
    state.requestInFlight = false;
    state.lastAssignedRole = null;
    state.dataSource = "unknown";
    state.liveNodeIndex = 0;
    state.liveNodeHistory = Array.from({ length: 8 }, () => []);
    state.sessionStartedAt = null;
    state.speechTurnStartedAt = null;
    state.lslActive = false;
    state.hasExportableData = false;

    el.scoreValue.textContent = "--%";
    el.scoreBar.style.width = "0%";
    el.scoreBar.textContent = "0%";
    el.windowsValue.textContent = "0";
    el.avgValue.textContent = "0%";
    el.confidenceValue.textContent = "0%";
    el.reportBox.textContent = "End a session to view report.";
    el.mockWarning.style.display = "none";

    renderTranscript();
    renderLiveGraph();
    renderSentimentRankingAnalysis();
    updateConnectionStatus();
    updateButtons();
    el.statusText.textContent = "Cleared. App is reset to initial state.";
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

    updateLiveNodeHistory(result);
    renderLiveGraph();
}

async function api(path, options = {}) {
    const response = await fetch(`${activeApiBaseUrl}${path}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
            ...(options.headers || {}),
        },
    });
    if (!response.ok) {
        let message = `Request failed: ${path}`;
        try {
            const payload = await response.json();
            message = payload.error || payload.message || message;
        } catch (error) {
            // Keep fallback message when body is not JSON.
        }
        throw new Error(message);
    }
    return response.json();
}

function getApiBaseCandidates() {
    const candidates = new Set();
    const fromOverride = normalizeApiBase(apiOverride);

    if (fromOverride) {
        candidates.add(fromOverride);
        candidates.add(API_BASE_URL);
        candidates.add(activeApiBaseUrl);
        // In explicit live mode (?api=...), never fall back to same-origin serverless routes
        // because they run mock-only logic and would hide hardware connectivity issues.
        return Array.from(candidates).filter(Boolean);
    }

    if (isLocalStatic) {
        candidates.add(`http://${host}:5050/api`);
    }

    candidates.add(`${window.location.origin}/api`);
    candidates.add(API_BASE_URL);
    candidates.add(activeApiBaseUrl);

    return Array.from(candidates).filter(Boolean);
}

async function resolveHealthyApiBase() {
    const candidates = getApiBaseCandidates();

    for (const baseUrl of candidates) {
        try {
            let isNgrok = false;
            try {
                const parsed = new URL(baseUrl);
                isNgrok = NGROK_HOST_PATTERN.test(parsed.hostname);
            } catch (error) {
                isNgrok = false;
            }

            const response = await fetch(`${baseUrl}/health`, {
                headers: isNgrok ? { "ngrok-skip-browser-warning": "true" } : {},
            });
            if (!response.ok) {
                continue;
            }

            const contentType = (response.headers.get("content-type") || "").toLowerCase();
            let payload;
            if (contentType.includes("application/json")) {
                payload = await response.json();
            } else {
                const text = await response.text();
                try {
                    payload = JSON.parse(text);
                } catch (error) {
                    // Some providers return HTML warnings/interstitials.
                    continue;
                }
            }

            activeApiBaseUrl = baseUrl;
            setApiBaseLabel(baseUrl, true);
            return { baseUrl, payload };
        } catch (error) {
            // Try next candidate.
        }
    }

    throw new Error("No healthy API base found");
}

function updateHardwareUI(connected, port, options = {}) {
    const { apiOnline = true, error = null, source = null } = options;
    const portLabel = port || "serial";
    const sourceLabel = source === "lsl" ? "LSL" : "OpenBCI";

    if (connected) {
        el.hwPill.textContent = `HW: ${port || "Connected"}`;
        el.hwPill.className = "pill pill-ok";
        el.hwBar.className = "hw-bar hw-bar-connected";
        el.hwIcon.innerHTML = "&#x2705;";
        el.hwMessage.textContent = `${sourceLabel} connected on ${portLabel}`;
        el.hwConnectBtn.style.display = "none";
        el.hwDisconnectBtn.style.display = "";
        el.portSelect.style.display = "none";
        el.mockWarning.style.display = "none";
    } else {
        if (!apiOnline) {
            el.hwPill.textContent = "HW: Last known";
            el.hwPill.className = "pill";
        } else {
            el.hwPill.textContent = "HW: Disconnected";
            el.hwPill.className = "pill pill-bad";
        }
        el.hwBar.className = "hw-bar hw-bar-disconnected";
        el.hwIcon.innerHTML = "&#x26A0;";
        if (!apiOnline) {
            el.hwMessage.textContent = "API offline. Showing last known hardware status.";
        } else if (error) {
            el.hwMessage.textContent = `OpenBCI not connected: ${error}`;
        } else {
            el.hwMessage.textContent = "OpenBCI not connected";
        }
        el.hwConnectBtn.style.display = "";
        el.hwDisconnectBtn.style.display = "none";
        el.portSelect.style.display = "";
    }
}

async function scanPorts() {
    try {
        const data = await api("/hardware/scan");
        el.portSelect.innerHTML = "";
        if (!data.ports.length) {
            el.portSelect.innerHTML = '<option value="">No ports found</option>';
            return;
        }
        for (const p of data.ports) {
            const opt = document.createElement("option");
            opt.value = p.port;
            opt.textContent = p.likely_openbci
                ? `${p.port} - ${p.description} (likely OpenBCI)`
                : `${p.port} - ${p.description}`;
            el.portSelect.appendChild(opt);
        }

        if (data && typeof data.source === "string") {
            state.hardwareSource = data.source;
        }
    } catch {
        el.portSelect.innerHTML = '<option value="">Scan failed</option>';
    }
}

async function connectHardware() {
    const mode = (el.sourceSelect && el.sourceSelect.value) || "auto";
    const port = el.portSelect.value;
    if (mode === "serial" && !port) return;
    el.hwConnectBtn.disabled = true;
    el.hwConnectBtn.textContent = "Connecting...";
    try {
        const payload = { mode };
        if (port) {
            payload.port = port;
        }
        const data = await api("/hardware/connect", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        state.hardwarePort = data.port || port;
        state.hardwareSource = data.source || state.hardwareSource;
        state.lslConnected = state.hardwareSource === "lsl";
        state.lslStreamName = state.lslConnected ? state.hardwarePort : null;
        state.openbciConnected = true;
        state.hardwareError = null;
        updateHardwareUI(true, state.hardwarePort, {
            apiOnline: true,
            error: null,
            source: state.hardwareSource,
        });
        state.hardwareConnected = true;
        state.dataSource = state.hardwareSource === "lsl" ? "live_lsl" : "openbci";
        updateConnectionStatus();
        updateButtons();
    } catch (error) {
        state.hardwareError = error.message;
        state.openbciConnected = false;
        updateHardwareUI(false, state.hardwarePort, {
            apiOnline: true,
            error: state.hardwareError,
            source: state.hardwareSource,
        });
        updateButtons();
    } finally {
        el.hwConnectBtn.disabled = false;
        el.hwConnectBtn.textContent = "Connect";
    }
}

async function disconnectHardware() {
    try {
        await api("/hardware/disconnect", { method: "POST" });
        state.hardwareError = null;
        updateHardwareUI(false, null, { apiOnline: true, error: null });
        state.hardwareConnected = false;
        state.hardwareSource = null;
        state.openbciConnected = false;
        state.lslConnected = false;
        state.lslStreamName = null;
        state.hardwarePort = null;
        updateConnectionStatus();
        updateButtons();
        scanPorts();
    } catch (error) {
        el.hwMessage.textContent = `Disconnect failed -- ${error.message}`;
    }
}

async function scoreUtterance() {
    state.requestInFlight = true;
    try {
        const result = await api("/session/process", {
            method: "POST",
            body: JSON.stringify({}),
        });
        state.lastResult = result;
        state.scores.push(result.deception_probability || 0);

        // Show mock data warning if not using live hardware
        if (result.data_source === "mock") {
            el.mockWarning.style.display = "";
        } else {
            el.mockWarning.style.display = "none";
        }

        updateSummary(result);

        return {
            nodes: buildNodeStressPercentages(result),
            stress: toPercent(result.deception_probability || 0),
            confidence: toPercent(result.confidence || 0),
        };
    } finally {
        state.requestInFlight = false;
    }
}

function buildLocalSessionReport() {
    const total = state.scores.length;
    const deceptive = state.scores.filter((score) => score > 0.7).length;
    const avg = total ? state.scores.reduce((a, b) => a + b, 0) / total : 0;

    return {
        total_windows: total,
        deceptive_windows: deceptive,
        average_deception_probability: avg,
        session_assessment: total
            ? (avg > 0.7 ? "Likely Deceptive" : "Likely Truthful")
            : "No session data captured",
    };
}

function getInterviewerPromptForIndex(intervieweeIndex) {
    for (let i = intervieweeIndex - 1; i >= 0; i -= 1) {
        const candidate = state.transcript[i];
        if (candidate && candidate.speaker === "Interviewer") {
            return candidate.text || "";
        }
    }
    return "";
}

function getTopIntervieweeStatements(metricKey) {
    return state.transcript
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry && entry.speaker === "Interviewee")
        .filter(({ entry }) => typeof entry[metricKey] === "number" && !Number.isNaN(entry[metricKey]))
        .sort((a, b) => b.entry[metricKey] - a.entry[metricKey])
        .slice(0, 5)
        .map(({ entry, index }) => ({
            ...entry,
            interviewerPrompt: getInterviewerPromptForIndex(index),
        }));
}

function buildRankingStatementBox(row) {
    if (!row) {
        return state.active ? "&nbsp;" : '<span class="ranking-empty-placeholder">--</span>';
    }

    const interviewerText = escapeHtml(row.interviewerPrompt || "");
    const intervieweeText = escapeHtml(row.text || "");

    return [
        '<div class="ranking-statement-block">',
        '<div class="ranking-statement-label">Interviewer</div>',
        `<div class="ranking-statement-text">${interviewerText || "&nbsp;"}</div>`,
        '<div class="ranking-statement-label">Interviewee</div>',
        `<div class="ranking-statement-text ranking-statement-answer">${intervieweeText || "&nbsp;"}</div>`,
        '</div>',
    ].join("");
}

function renderSentimentRankingAnalysis() {
    if (!el.sentimentRankingBody) {
        return;
    }

    const topStress = getTopIntervieweeStatements("stress");
    const topConfidence = getTopIntervieweeStatements("confidence");
    const rows = [];

    for (let i = 0; i < 5; i += 1) {
        const stressRow = topStress[i] || null;
        const confidenceRow = topConfidence[i] || null;

        const stressStatement = buildRankingStatementBox(stressRow);
        const stressPercent = stressRow ? `${stressRow.stress.toFixed(1)}%` : (state.active ? "&nbsp;" : '<span class="ranking-empty-placeholder">--</span>');
        const confidenceStatement = buildRankingStatementBox(confidenceRow);
        const confidencePercent = confidenceRow ? `${confidenceRow.confidence.toFixed(1)}%` : (state.active ? "&nbsp;" : '<span class="ranking-empty-placeholder">--</span>');

        rows.push([
            "<tr>",
            `<td>${i + 1}</td>`,
            `<td class="ranking-statement-cell">${stressStatement}</td>`,
            `<td class="ranking-percent-cell">${stressPercent}</td>`,
            `<td class="ranking-statement-cell">${confidenceStatement}</td>`,
            `<td class="ranking-percent-cell">${confidencePercent}</td>`,
            "</tr>",
        ].join(""));
    }

    el.sentimentRankingBody.innerHTML = rows.join("");
}

async function checkHealth() {
    try {
        const { payload: health } = await resolveHealthyApiBase();
        state.apiOnline = true;
        el.health.textContent = "API Online";
        el.health.className = "pill pill-ok";

        if (typeof health.hardware_connected === "boolean") {
            state.hardwareConnected = health.hardware_connected;
        } else if (typeof health.connected === "boolean") {
            // Support older health payloads that use "connected".
            state.hardwareConnected = health.connected;
        }

        if (typeof health.session_active === "boolean") {
            state.sessionActive = health.session_active;
        }

        if (typeof health.hardware_source === "string" || health.hardware_source === null) {
            state.hardwareSource = health.hardware_source;
        }

        if (typeof health.lsl_connected === "boolean") {
            state.lslConnected = health.lsl_connected;
        } else {
            state.lslConnected = state.hardwareSource === "lsl";
        }
        state.openbciConnected = state.hardwareConnected || state.hardwareSource === "serial" || state.hardwareSource === "lsl";

        if (typeof health.lsl_stream_name === "string" || health.lsl_stream_name === null) {
            state.lslStreamName = health.lsl_stream_name;
        }

        if (typeof health.hardware_error === "string" || health.hardware_error === null) {
            state.hardwareError = health.hardware_error;
        }

        if (health.hardware_port) {
            state.hardwarePort = health.hardware_port;
        }

        // Some deployments expose hardware and session details separately.
        try {
            const hardware = await api("/hardware/status");
            if (typeof hardware.connected === "boolean") {
                state.hardwareConnected = hardware.connected;
            }
            if (typeof hardware.source === "string" || hardware.source === null) {
                state.hardwareSource = hardware.source;
            }
            if (hardware.port) {
                state.hardwarePort = hardware.port;
            }
            if (typeof hardware.lsl_connected === "boolean") {
                state.lslConnected = hardware.lsl_connected;
            }
            state.openbciConnected = state.hardwareConnected || state.hardwareSource === "serial" || state.hardwareSource === "lsl";
            if (typeof hardware.lsl_stream_name === "string" || hardware.lsl_stream_name === null) {
                state.lslStreamName = hardware.lsl_stream_name;
            }
            if (typeof hardware.error === "string" || hardware.error === null) {
                state.hardwareError = hardware.error;
            }
        } catch (error) {
            // Ignore when hardware route is not available (for hosted serverless APIs).
        }

        if (typeof health.session_active !== "boolean") {
            try {
                const session = await api("/session/status");
                if (typeof session.session_active === "boolean") {
                    state.sessionActive = session.session_active;
                }
            } catch (error) {
                // Ignore when session status route is unavailable.
            }
        }

        updateConnectionStatus();
        updateHardwareUI(state.hardwareConnected, state.hardwarePort, {
            apiOnline: true,
            error: state.hardwareError,
            source: state.hardwareSource,
        });
        updateButtons();
    } catch (error) {
        state.apiOnline = false;
        el.health.textContent = "API Offline";
        el.health.className = "pill pill-bad";
        setApiBaseLabel(activeApiBaseUrl, false);
        if (apiOverride && el.statusText) {
            el.statusText.textContent = "API override is offline. Verify ngrok tunnel is running and /api/health returns JSON.";
        }
        // Keep last known states to avoid false red flips during brief tunnel/network drops.
        updateConnectionStatus();
        updateHardwareUI(state.hardwareConnected, state.hardwarePort, {
            apiOnline: false,
            error: state.hardwareError,
            source: state.hardwareSource,
        });
        updateButtons();
    }
}

async function startSession() {
    if (!canStartInterview()) {
        throw new Error(buildPreflightMessage() || "Start prerequisites not met");
    }

    let hardwareMessage = "";
    let hardwareConnected = false;
    const mode = (el.sourceSelect && el.sourceSelect.value) || "auto";
    const selectedPort = el.portSelect && el.portSelect.value ? el.portSelect.value : null;
    try {
        const payload = { mode };
        if (selectedPort) {
            payload.port = selectedPort;
        }
        const hardware = await api("/hardware/connect", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        if (hardware && (hardware.status === "connected" || hardware.status === "already_connected")) {
            hardwareMessage = `Hardware: ${hardware.status.replace("_", " ")}`;
            state.hardwareSource = hardware.source || state.hardwareSource;
            state.dataSource = state.hardwareSource === "lsl" ? "live_lsl" : "openbci";
            state.hardwareConnected = true;
            hardwareConnected = true;
            state.hardwarePort = hardware.port || selectedPort;
            state.lslConnected = state.hardwareSource === "lsl";
            state.lslStreamName = state.lslConnected ? state.hardwarePort : null;
            state.hardwareError = null;
            updateHardwareUI(true, state.hardwarePort, {
                apiOnline: true,
                error: null,
                source: state.hardwareSource,
            });
        }
    } catch (error) {
        // Even if direct serial connect fails, LSL may still be active
        if (state.lslActive && state.socketConnected) {
            hardwareMessage = "Connected via LSL stream";
            state.dataSource = "openbci";
            state.hardwareConnected = true;
            hardwareConnected = true;
        } else {
            hardwareMessage = "Hardware unavailable";
            state.hardwareConnected = false;
            state.hardwareSource = null;
            state.lslConnected = false;
            state.lslStreamName = null;
            state.dataSource = "unknown";
            state.hardwareError = error.message;
            updateHardwareUI(false, state.hardwarePort, {
                apiOnline: true,
                error: state.hardwareError,
                source: state.hardwareSource,
            });
            if (isLiveOverride) {
                el.mockWarning.style.display = "none";
                throw new Error(`OpenBCI hardware connect failed: ${error.message}`);
            }
            state.dataSource = "mock";
            hardwareMessage = "Hardware unavailable, using mock EEG data";
        }
    }

    if (!hardwareMessage && !hardwareConnected) {
        // Check LSL before falling back to mock
        if (state.lslActive && state.socketConnected) {
            state.dataSource = "openbci";
            hardwareMessage = "Connected via LSL stream";
        } else {
            state.dataSource = "mock";
        }
    }

    await api("/session/start", { method: "POST" });
    state.active = true;
    state.sessionActive = true;
    state.scores = [];
    state.lastResult = null;
    state.transcript = [];
    state.selectedTranscriptRow = null;
    state.lastAssignedRole = null;
    state.liveNodeHistory = Array.from({ length: 8 }, () => []);
    state.liveNodeIndex = 0;
    state.sessionStartedAt = Date.now();
    state.speechTurnStartedAt = null;
    state.requestInFlight = false;
    state.hasExportableData = false;
    renderTranscript();
    el.reportBox.textContent = hardwareMessage
        ? `Session started. ${hardwareMessage}. Listening for conversation...`
        : "Session started. Listening for conversation...";
    el.statusText.textContent = state.dataSource === "openbci" || state.dataSource === "live_lsl"
        ? "Conversation capture active (interviewee live EEG scoring)"
        : (isLiveOverride
            ? "Session started, but headset is disconnected. Close OpenBCI GUI and reconnect board."
            : "Conversation capture active (scores paused until OpenBCI source is connected)");

    if (!state.micEnabled) {
        try {
            await enableMic();
        } catch (error) {
            el.micCaption.textContent = "Mic transcript: microphone permission denied or unavailable";
        }
    }

    updateButtons();
    updateConnectionStatus();
    startEegCapture();
    renderLiveGraph();
    if (state.micEnabled && state.speechRecognition) {
        try {
            state.speechRecognition.start();
        } catch (error) {
            // Ignore duplicate starts when already listening.
        }
    }
    el.statusText.textContent = state.dataSource === "openbci" || state.dataSource === "live_lsl"
        ? "Conversation capture active (interviewee live EEG scoring)"
        : (isLiveOverride
            ? "Session started, but headset is disconnected. Close OpenBCI GUI and reconnect board."
            : "Conversation capture active (scores paused until OpenBCI source is connected)");
}

async function runSample() {
    el.statusText.textContent = "Run Sample is disabled. Rows are now added only from recorded conversation.";
}

async function endSession() {
    state.active = false;
    state.sessionActive = false;
    state.speechTurnStartedAt = null;
    stopEegCapture();
    if (state.speechRecognition && state.micListening) {
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op if recognition is already stopped.
        }
    }
    let report;
    try {
        report = await api("/session/end", { method: "POST" });
    } catch (error) {
        report = buildLocalSessionReport();
        report.session_assessment = "Interview ended locally (summary unavailable from API)";
    }

    if ((!report || report.total_windows === 0) && state.scores.length > 0) {
        report = buildLocalSessionReport();
    }

    const sourceLabel = state.dataSource === "openbci"
        ? "OpenBCI headset"
        : (state.dataSource === "live_lsl" ? "LSL live stream" : "Mock/demo signal");

    state.requestInFlight = false;
    state.hasExportableData = hasSessionDataForExport();
    updateButtons();
    updateConnectionStatus();
    renderLiveGraph();
    el.reportBox.innerHTML = [
        '<div class="report-summary">',
        `<div>Data source: ${sourceLabel}</div>`,
        `<div>Total windows: ${report.total_windows}</div>`,
        `<div>Deceptive windows: ${report.deceptive_windows}</div>`,
        `<div>Average probability: ${(report.average_deception_probability * 100).toFixed(1)}%</div>`,
        `<div>Assessment: ${report.session_assessment}</div>`,
        '</div>',
    ].join("");
    renderSentimentRankingAnalysis();
}

async function exportSession() {
    const exportAllowed = !state.active
        && el.startBtn.disabled
        && el.endBtn.disabled
        && state.hasExportableData;

    if (!exportAllowed) {
        el.statusText.textContent = "Export is available only when Start and End are unavailable and session data exists.";
        return;
    }

    if (!hasSessionDataForExport()) {
        state.hasExportableData = false;
        updateButtons();
        el.statusText.textContent = "No session data to export.";
        return;
    }

    let exported = null;
    try {
        exported = await api("/session/export", { method: "POST" });
    } catch (error) {
        // Continue with client-side export even when server export endpoint fails.
    }

    const payload = buildClientExportPayload(exported);
    downloadJsonFile(payload);

    el.reportBox.innerHTML = [
        `Export status: ${exported && exported.status ? exported.status : "downloaded"}`,
        `Saved file: ${exported && exported.file ? exported.file : "browser download"}`,
        `Entries: ${exported && typeof exported.entries === "number" ? exported.entries : state.scores.length}`,
    ].join("<br>");
}

el.startBtn.addEventListener("click", () => startSession().catch((e) => (el.statusText.textContent = e.message)));
el.sampleBtn.addEventListener("click", () => runSample().catch((e) => (el.statusText.textContent = e.message)));
el.endBtn.addEventListener("click", () => endSession().catch((e) => (el.statusText.textContent = e.message)));
if (el.clearBtn) {
    el.clearBtn.addEventListener("click", () => clearAll());
}
el.micBtn.addEventListener("click", () => toggleMic().catch((e) => (el.statusText.textContent = e.message)));
el.exportBtn.addEventListener("click", () => exportSession().catch((e) => (el.statusText.textContent = e.message)));
el.hwConnectBtn.addEventListener("click", () => connectHardware());
el.hwDisconnectBtn.addEventListener("click", () => disconnectHardware());
el.transcriptLog.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.classList.contains("transcript-view-select")) {
        return;
    }

    const index = Number(target.getAttribute("data-row-index"));
    if (Number.isNaN(index) || !state.transcript[index]) {
        return;
    }

    state.transcript[index].visualization = target.value;
    state.selectedTranscriptRow = index;
    renderTranscript();
});
el.transcriptLog.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const row = target.closest("tr[data-row-index]");
    if (!row) {
        return;
    }

    const index = Number(row.getAttribute("data-row-index"));
    if (Number.isNaN(index) || !state.transcript[index]) {
        return;
    }

    state.selectedTranscriptRow = index;
    renderTranscript();
});
if (el.sourceSelect) {
    el.sourceSelect.addEventListener("change", updateSourceModeUi);
}
if (el.liveGraphSelect) {
    el.liveGraphSelect.value = state.liveVisualization;
    el.liveGraphSelect.addEventListener("change", () => {
        state.liveVisualization = el.liveGraphSelect.value;
        renderLiveGraph();
    });
}
if (el.liveNodePicker) {
    el.liveNodePicker.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement) || !target.classList.contains("live-node-btn")) {
            return;
        }

        const nextIndex = Number(target.getAttribute("data-node-index"));
        if (Number.isNaN(nextIndex) || nextIndex < 0 || nextIndex > 7) {
            return;
        }

        state.liveNodeIndex = nextIndex;
        renderLiveGraph();
    });
}
window.addEventListener("beforeunload", () => {
    stopEegCapture();
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
renderLiveGraph();
renderSentimentRankingAnalysis();
updateConnectionStatus();
updateSourceModeUi();
checkHealth();
scanPorts();
setInterval(() => {
    checkHealth();
}, STATUS_REFRESH_INTERVAL_MS);
