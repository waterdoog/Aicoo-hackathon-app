const { createParticipant, listParticipants, readBody, send, sendError } = require("../../_aicoo");

module.exports = async function handler(req, res) {
  const { slug } = req.query;
  try {
    if (req.method === "GET") {
      const participants = await listParticipants(slug);
      return send(res, 200, { ok: true, participants });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const participant = await createParticipant(slug, body);
      return send(res, 201, { ok: true, participant });
    }
    return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
};
