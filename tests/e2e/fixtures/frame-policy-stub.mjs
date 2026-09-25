// Minimal stand-in for the api's GET /api/embed/frame-policy, so the frontend's
// server-side CSP middleware (which Playwright cannot intercept) can be exercised.
import { createServer } from 'node:http'

const ALLOWED_TOKEN = 'allowed-token'
const ALLOWED_DOMAINS = ['localhost:4175']
const port = Number(process.env.STUB_PORT ?? 4175)

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub')
  if (url.pathname === '/host') {
    // A real (loopback) host page: a Playwright-fulfilled page is treated as public
    // address space by Chromium, which then blocks framing anything on loopback.
    res.setHeader('content-type', 'text/html')
    const src = JSON.stringify(url.searchParams.get('src') ?? '')
    res.end(
      `<!doctype html><title>host</title><iframe width="1100" height="600"></iframe><script>document.querySelector('iframe').src = ${src}</script>`
    )
    return
  }
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/api/health') {
    res.end('{"status":"ok"}')
  } else if (
    url.pathname === '/api/embed/frame-policy' &&
    url.searchParams.get('token') === ALLOWED_TOKEN
  ) {
    res.end(JSON.stringify({ allowed_domains: ALLOWED_DOMAINS }))
  } else {
    res.statusCode = 401
    res.end('{"code":"token_invalid"}')
  }
}).listen(port)
