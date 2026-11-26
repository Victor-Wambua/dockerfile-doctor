'use strict';
// Used by HEALTHCHECK: the distroless image has no curl or shell.
const http = require('node:http');

const req = http.get({ host: '127.0.0.1', port: process.env.PORT || 8080, path: '/health', timeout: 2000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
