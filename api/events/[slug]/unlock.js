const db = require("../../../lib/db");
const { readBody, sanitizeEvent, send, sendError, verifyEventCode } = require("../../_aicoo");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });
  try {
    const { slug } = req.query;
    const body = await readBody(req);
    const event = (await db.listEvents()).find((item) => item.slug === slug);
    if (!event) return send(res, 404, { ok: false, error: "Event not found." });
    if (!verifyEventCode(event, body)) {
      return send(res, 403, { ok: false, error: "Wrong access code." });
    }
    // The client echoes this code back via the x-event-code header on reads.
    const code = String(body.accessCode || body.inviteToken || "").trim();
    send(res, 200, { ok: true, event: sanitizeEvent(event), eventCode: code });
  } catch (error) {
    sendError(res, error);
  }
};
