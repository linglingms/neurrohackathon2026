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

function channelStress(channelValues) {
  const values = Array.isArray(channelValues) ? channelValues : [];
  if (!values.length) return 0.5;

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
  return Math.max(0, Math.min(1, 0.65 * ratioNorm + 0.35 * varNorm));
}

function scoreFromEEG(eegData) {
  const channels = Array.isArray(eegData) ? eegData : [];
  if (!channels.length) return 0.5;

  const perChannel = channels.map((channel) => channelStress(channel));
  const overall = perChannel.reduce((a, b) => a + b, 0) / perChannel.length;

  const nodeStress = perChannel.slice(0, 8);
  while (nodeStress.length < 8) {
    nodeStress.push(overall);
  }

  return {
    overall,
    nodeStress,
  };
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

export {
  getSession,
  generateMockEEG,
  scoreFromEEG,
  buildReport,
};
