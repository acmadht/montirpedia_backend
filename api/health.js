module.exports = function handler(req, res) {
  return res.status(200).json({
    success: true,
    message: "Montirpedia backend aktif.",
  });
};