// 在本机运行中转服务器，方便开发和测试：
//   node worker/dev.mjs        （默认端口 8787）
// 然后把 js/config.js 里的 PROXY_URL 临时改成 http://localhost:8787
import http from 'node:http';
import worker from './worker.js';

const port = Number(process.env.PORT) || 8787;

http.createServer(async (req, res) => {
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
  });
  const response = await worker.fetch(request, {}, {});
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
}).listen(port, () => console.log(`中转服务器运行在 http://localhost:${port}`));
