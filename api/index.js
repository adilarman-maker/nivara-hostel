// Vercel entry point. All requests (both /api/* and the static frontend)
// are routed here by vercel.json and handled by the same Express app you
// run locally with `npm start` — nothing about the app's own logic differs
// between local and Vercel.
module.exports = require('../server');
