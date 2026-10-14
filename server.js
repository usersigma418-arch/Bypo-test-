const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const SOLVER_SECRET = process.env.SOLVER_SECRET || 'change-me-please';
const TARGET = 'https://thescholarverse.site';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cache state
let cachedCookie = null;
let cookieExpiry = 0;
let solvingPromise = null;
let browserInstance = null;

// ---------- Browser launch (stealth-friendly) ----------
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  console.log('[browser] launching...');
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',       // Render low-RAM ke liye
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-blink-features=AutomationControlled', // ⭐ Stealth
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,720',
    ],
  });
  console.log('[browser] launched');
  return browserInstance;
}

// ---------- Turnstile solve ----------
async function solveTurnstile() {
  console.log('[solver] start at', new Date().toISOString());
  const start = Date.now();

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });

  // ⭐ Webdriver flag hatao — Cloudflare headless detect karta hai isse
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // chrome runtime object
    window.chrome = { runtime: {} };
    // permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  });

  const page = await ctx.newPage();

  // Log console + failures for debugging
  page.on('console', msg => console.log('[page]', msg.type(), msg.text().slice(0, 200)));
  page.on('pageerror', err => console.log('[page error]', err.message));
  page.on('requestfailed', req => console.log('[req failed]', req.url().slice(0, 100), req.failure()?.errorText));

  try {
    console.log('[solver] navigating to', TARGET);
    await page.goto(TARGET + '/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    console.log('[solver] page loaded, waiting for cookie...');

    const deadline = Date.now() + 90000; // ⭐ 60 → 90 sec
    let attempts = 0;

    while (Date.now() < deadline) {
      const cookies = await ctx.cookies();
      const c = cookies.find(x => x.name === 'cf_turnstile_clearance' && x.value);

      if (c) {
        const cookieStr = cookies
          .filter(x => x.domain.includes('scholarverse'))
          .map(x => `${x.name}=${x.value}`)
          .join('; ');
        console.log(`[solver] ✅ cookie obtained in ${Date.now() - start}ms, len=${cookieStr.length}`);
        return cookieStr;
      }

      attempts++;
      if (attempts % 10 === 0) {
        console.log(`[solver] still waiting... ${Math.round((Date.now() - start) / 1000)}s`);

        // Har 10 sec pe Turnstile iframe check karo
        const hasTurnstile = await page.evaluate(() => {
          return !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        }).catch(() => false);

        if (!hasTurnstile && attempts > 20) {
          console.log('[solver] no turnstile iframe found, reloading page...');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      }

      await page.waitForTimeout(1000);
    }

    // Timeout — screenshot save karo debug ke liye
    console.log('[solver] ❌ timeout, taking screenshot...');
    const shot = await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
    if (shot) {
      console.log('[solver] screenshot size:', shot.length, 'bytes');
    }

    throw new Error('timeout waiting for cookie');
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---------- Cookie cache wrapper ----------
async function getCookie(force = false) {
  if (!force && cachedCookie && Date.now() < cookieExpiry) {
    return cachedCookie;
  }
  if (solvingPromise) return solvingPromise;

  solvingPromise = solveTurnstile()
    .then(c => {
      cachedCookie = c;
      cookieExpiry = Date.now() + 13 * 60 * 1000; // 13 min
      solvingPromise = null;
      return c;
    })
    .catch(e => {
      solvingPromise = null;
      // Browser crash hua to reset
      if (browserInstance) {
        browserInstance.close().catch(() => {});
        browserInstance = null;
      }
      throw e;
    });

  return solvingPromise;
}

// ---------- Routes ----------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    cached: !!cachedCookie,
    expiresIn: Math.max(0, Math.floor((cookieExpiry - Date.now()) / 1000)),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
    solving: !!solvingPromise,
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

    // 403 → cookie expire, refresh + retry
    if (r.status === 403) {
      console.log('[proxy] got 403, forcing cookie refresh...');
      const fresh = await getCookie(true);
      const retry = await fetch(url, {
        headers: {
          'Cookie': fresh,
          'User-Agent': UA,
          'Referer': TARGET + '/',
          'Origin': TARGET,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const retryBody = await retry.text();
      console.log(`[proxy] retry ${path} -> ${retry.status}`);
      return res.status(retry.status)
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(retryBody);
    }

    console.log(`[proxy] ${path} -> ${r.status} (solve ${solveTime}ms, total ${Date.now() - start}ms)`);
    res.status(r.status)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(body);
  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Solver on :${PORT}`);
  console.log(`Target: ${TARGET}`);
  console.log(`Secret set: ${SOLVER_SECRET !== 'change-me-please' ? 'yes' : 'NO — CHANGE IT'}`);
  // Pre-warm cookie
  getCookie().catch(e => console.error('[prewarm]', e.message));
});
