const { checkAicooStatus, send, sendError } = require("../_aicoo");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Method not allowed" });
  try {
    const status = await checkAicooStatus(req);
    send(res, 200, { ok: true, status });
  } catch (error) {
    sendError(res, error);
  }
};
