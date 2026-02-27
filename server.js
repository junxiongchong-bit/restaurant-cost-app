const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.pdf':  'application/pdf',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const fp = path.join(__dirname, url);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(fp);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(3000, '127.0.0.1', () => {
  console.log('Restaurant Cost Control running at http://localhost:3000');
});
