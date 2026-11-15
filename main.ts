import * as http from 'node:http';
import { createApp } from './app.ts';

if (!process.env.MAKEFUN_ENV_URL) {
  process.exit(1);
}

const server = createApp();
server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as http.AddressInfo).port;
  console.log(`PORT ${port}`);

  register(port);
});

async function register(port: number) {
  const data = JSON.stringify({ port });
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };

  const req = http.request(`${process.env.MAKEFUN_ENV_URL}/register`, options, (res) => {
    if (res.statusCode === 200 || res.statusCode === 409) {
      pollDone();
    } else {
      // Failed to register, keep trying? Or exit?
      // The instructions say "if the register POST returns 409... keep waiting".
      // What if it returns something else? Instructions: "register attempted ... well within 20s"
      // I will retry if it fails.
      setTimeout(() => register(port), 1000);
    }
  });
  req.on('error', () => {
    setTimeout(() => register(port), 1000);
  });
  req.write(data);
  req.end();
}

let backoff = 200;
async function pollDone() {
  const req = http.get(`${process.env.MAKEFUN_ENV_URL}/done`, (res) => {
    if (res.statusCode === 200) {
      process.exit(0);
    } else {
      backoff = Math.min(backoff * 2, 5000);
      setTimeout(pollDone, backoff);
    }
  });
  req.on('error', () => {
    backoff = Math.min(backoff * 2, 5000);
    setTimeout(pollDone, backoff);
  });
}
