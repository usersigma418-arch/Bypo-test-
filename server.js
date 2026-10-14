const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const SOLVER_SECRET = process.env.SOLVER_SECRET || 'change-me-please';
const TARGET = 'https://thescholarverse.site';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cookie cache
let cachedCookie = null;
let cookieExpiry = 0;
let solvingPromise = null;
let browserInstance = null;

// Reuse browser (RAM bachane ke liye) — par Render pe risky bhi hai
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // ⚠️ Important for low-RAM environments
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--single-process', // ⚠️ RAM bachata hai, par stability kam
      '--no-zygote',
    ],
  });
  return browserInstance;
}

async function solveTurnstile() {
  console.log('[solver] solving at', new Date().toISOString());
  const start = Date.now();

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
  });

  try {
    const page = await ctx.newPage();
    await page.goto(TARGET + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const cookies = await ctx.cookies();
      const c = cookies.find(x => x.name === 'cf_turnstile_clearance' && x.value);
      if (c) {
        const cookieStr = cookies
          .filter(x => x.domain.includes('scholarverse'))
          .map(x => `${x.name}=${x.value}`)
          .join('; ');
        console.log(`[solver] success in ${Date.now() - start}ms`);
        return cookieStr;
      }
      await page.waitForTimeout(500);
    }
    throw new Error('timeout waiting for cookie');
  } finally {
    await ctx.close(); // Context close karo, browser nahi (reuse)
  }
}

async function getCookie(force = false) {
  if (!force && cachedCookie && Date.now() < cookieExpiry) {
    return cachedCookie;
  }
  if (solvingPromise) return solvingPromise;

  solvingPromise = solveTurnstile()
    .then(c => {
      cachedCookie = c;
      cookieExpiry = Date.now() + 13 * 60 * 1000;
      solvingPromise = null;
      return c;
    })
    .catch(e => {
      solvingPromise = null;
      // Browser crash hua to reset karo
      if (browserInstance) {
        browserInstance.close().catch(() => {});
        browserInstance = null;
      }
      throw e;
    });

  return solvingPromise;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    cached: !!cachedCookie,
    expiresIn: Math.max(0, Math.floor((cookieExpiry - Date.now()) / 1000)),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
  });
});

app.get('/proxy', async (req, res) => {
  if (req.headers['x-solver-secret'] !== SOLVER_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const path = req.query.path;
  const q = req.query.q || '';
  if (!path || !path.startsWith('/api/')) {
    return res.status(400).json({ error: 'bad path' });
  }

  try {
    const start = Date.now();
    const cookie = await getCookie();
    const solveTime = Date.now() - start;

    const url = `${TARGET}${path}${q ? '?' + q : ''}`;
    const r = await fetch(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': UA,
        'Referer': TARGET + '/',
        'Origin': TARGET,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const body = await r.text();

    // 403 = cookie expire. Force refresh + retry
    if (r.status === 403) {
      console.log('[proxy] 403, refreshing cookie...');
      const fresh = await getCookie(true);
      const retry = await fetch(url, {
        headers: {
          'Cookie': fresh,
          'User-Agent': UA,
          'Referer': TARGET + '/',
          'Origin': TARGET,
          'Accept': 'application/json, text/plain, */*',
        },
      });
      return res.status(retry.status)
        .set('Content-Type', 'application/json')
        .send(await retry.text());
    }

    console.log(`[proxy] ${path} -> ${r.status} (solve ${solveTime}ms, total ${Date.now() - start}ms)`);
    res.status(r.status)
      .set('Content-Type', 'application/json')
      .send(body);
  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Solver on :${PORT}`);
  // Pre-warm
  getCookie().catch(e => console.error('[prewarm]', e.message));
});
