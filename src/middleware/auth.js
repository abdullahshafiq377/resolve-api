// AUTH NOT IMPLEMENTED
// This middleware is a placeholder. Protected routes (POST/PUT/DELETE) are
// currently unprotected. Implement JWT or API-key verification before deploying
// to a public environment. In production this will return 501 to prevent
// accidental exposure.
function auth(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(501).json({ error: 'Authentication not implemented' });
  }
  next();
}

module.exports = auth;
