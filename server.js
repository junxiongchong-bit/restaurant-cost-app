const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.pdf':  'application/pdf',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Recursively fetch all Square orders (handles cursor pagination)
async function fetchAllSquareOrders(token, locationIds, from, to, cursor) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      location_ids: locationIds,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: from, end_at: to } },
          state_filter: { states: ['COMPLETED', 'OPEN'] },
        },
      },
      ...(cursor ? { cursor } : {}),
    });

    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/orders/search',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          const orders = json.orders || [];
          if (json.cursor) {
            const more = await fetchAllSquareOrders(token, locationId, from, to, json.cursor);
            resolve(orders.concat(more));
          } else {
            resolve(orders);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Square orders proxy
  if (req.url === '/api/square-orders' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { token, locationId, from, to } = JSON.parse(body);
        if (!token || !locationId || !from || !to) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ error: 'Missing required fields' }));
          return;
        }
        const orders = await fetchAllSquareOrders(token, locationId, from, to);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ orders }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static file serving
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
