module.exports = async function handler(req, res) {
  return res.status(200).json({
    success: true,
    endpoint: '/api/ping',
    status: 'online',
    time: new Date().toISOString(),
  });
};