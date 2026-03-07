import { getSession } from "./utils.js";

export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession();
  return res.status(200).json({
    session_active: !!session.active,
    hardware_connected: false,
  });
}
