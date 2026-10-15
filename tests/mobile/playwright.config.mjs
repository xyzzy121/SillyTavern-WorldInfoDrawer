import { defineConfig } from '@playwright/test';
import { output } from './helpers.mjs';
const sizes = [[320,568],[360,800],[390,844],[430,932],[844,390],[390,420],[768,1024]];
const baseURL = process.env.ST_BASE_URL;
if (!baseURL) throw new Error('Set ST_BASE_URL to an isolated SillyTavern host, for example http://127.0.0.1:8001.');
const address = new URL(baseURL);
if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || Number(address.port) < 8001) throw new Error('Mobile tests require an isolated HTTP loopback host on port 8001 or above.');
export default defineConfig({
  testDir: '.', testMatch: '*.spec.mjs', timeout: 90000, expect: { timeout: 8000 },
  workers: 1, retries: 0, fullyParallel: false, forbidOnly: true,
  outputDir: `${output}/artifacts`,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }], ['html', { outputFolder: `${output}/html-report`, open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 10000 },
  projects: ['chromium', 'webkit'].flatMap(browserName => sizes.map(([width,height]) => ({
    name: `${browserName}-${width}x${height}`,
    use: { browserName, viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
      userAgent: browserName === 'webkit' ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' : 'Mozilla/5.0 (Linux; Android 15; Mobile QA) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
    },
  }))),
});
