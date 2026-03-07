import { getSession } from "./utils.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession();
  session.results = [];
  session.startedAt = new Date().toISOString();
  session.lastReport = null;

  return res.status(200).json({ status: "session_started", message: "New session initialized" });
}
