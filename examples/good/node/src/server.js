'use strict';
const http = require('node:http');

const port = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'sample-node-service', uid: process.getuid?.() }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`listening on ${port}`);
});

// Graceful shutdown: exec-form CMD means Node is PID 1 and receives these signals directly.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
