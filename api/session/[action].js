const sessions = new Map();

function getSession() {
  if (!sessions.has("default")) {
    sessions.set("default", { results: [], startedAt: null, lastReport: null });
  }
  return sessions.get("default");
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function generateMockEEG({ channels = 8, samples = 500, deceptive = false } = {}) {
  const data = [];
  for (let c = 0; c < channels; c += 1) {
    const channel = [];
    for (let i = 0; i < samples; i += 1) {
      const alpha = Math.sin((2 * Math.PI * 10 * i) / 250);
      const beta = Math.sin((2 * Math.PI * 20 * i) / 250);
      const noise = randomBetween(-0.2, 0.2);
      channel.push((deceptive ? 0.4 * alpha + 1.1 * beta : 1.0 * alpha + 0.4 * beta) + noise);
    }
    data.push(channel);
  }
  return data;
}

function scoreFromEEG(eegData) {
  const channels = Array.isArray(eegData) ? eegData : [];
  if (!channels.length) return 0.5;

  let combined = 0;
  channels.forEach((channel) => {
    const values = Array.isArray(channel) ? channel : [];
    if (!values.length) return;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);

    let high = 0;
    let low = 0;
    for (let i = 1; i < values.length; i += 1) {
      const delta = Math.abs(values[i] - values[i - 1]);
      if (i % 2 === 0) high += delta;
      else low += delta;
    }

    const ratio = high / Math.max(low, 1e-6);
    const ratioNorm = Math.min(ratio, 4) / 4;
    const varNorm = Math.min(std / 1.2, 1);
    combined += 0.65 * ratioNorm + 0.35 * varNorm;
  });

  const score = combined / channels.length;
  return Math.max(0, Math.min(1, score));
}

function buildReport(session) {
  const probs = session.results.map((r) => r.deception_probability);
  if (!probs.length) return null;

  const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
  const deceptiveCount = session.results.filter((r) => r.is_deceptive).length;

  return {
    session_started_at: session.startedAt,
    session_ended_at: new Date().toISOString(),
    total_windows: session.results.length,
    deceptive_windows: deceptiveCount,
    average_deception_probability: avg,
    session_assessment: avg > 0.7 ? "Likely Deceptive" : "Likely Truthful",
  };
}

export default function handler(req, res) {
  const action = req.query.action;
  const session = getSession();

  if (action === "start" && req.method === "POST") {
    session.results = [];
    session.startedAt = new Date().toISOString();
    session.lastReport = null;
    return res.status(200).json({ status: "session_started", message: "New session initialized" });
  }

  if (action === "process" && req.method === "POST") {
    const body = req.body || {};
    const eegData = body.eeg_data || generateMockEEG({ deceptive: !!body.deceptive });
    const deceptionProbability = scoreFromEEG(eegData);

    const result = {
      deception_probability: deceptionProbability,
      is_deceptive: deceptionProbability > 0.7,
      confidence: Math.max(deceptionProbability, 1 - deceptionProbability),
      windows_processed: 1,
      predictions: [deceptionProbability],
    };

    session.results.push(result);
    return res.status(200).json(result);
  }

  if (action === "end" && req.method === "POST") {
    const report = buildReport(session);
    if (!report) return res.status(400).json({ error: "No session data" });
    session.lastReport = report;
    return res.status(200).json(report);
  }

  if (action === "export" && req.method === "POST") {
    const report = session.lastReport || buildReport(session);
    if (!report) return res.status(400).json({ error: "No session data to export" });

    return res.status(200).json({
      status: "exported",
      file: `vercel-memory/session_${Date.now()}.json`,
      entries: session.results.length,
      payload: { report, results: session.results },
    });
  }

  return res.status(404).json({ error: "Route not found" });
}
