import { getSession, generateMockEEG, scoreFromEEG } from "./utils.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession();
  const body = req.body || {};
  const eegData = body.eeg_data || generateMockEEG({ deceptive: !!body.deceptive });

  const { overall, nodeStress } = scoreFromEEG(eegData);

  const result = {
    deception_probability: overall,
    is_deceptive: overall > 0.7,
    confidence: Math.max(overall, 1 - overall),
    windows_processed: 1,
    predictions: [overall],
    node_stress: nodeStress,
    node_labels: ["Node 1", "Node 2", "Node 3", "Node 4", "Node 5", "Node 6", "Node 7", "Node 8"],
  };

  session.results.push(result);
  return res.status(200).json(result);
}
