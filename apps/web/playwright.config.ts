import { defineConfig, devices } from '@playwright/test';

const apiUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8080/api';
const disableAbly = process.env.PLAYWRIGHT_DISABLE_ABLY ?? '1';
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const useWebServer = process.env.PLAYWRIGHT_USE_WEB_SERVER
    ? process.env.PLAYWRIGHT_USE_WEB_SERVER !== '0'
    : /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl);
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_WEB_SERVER
    ? process.env.PLAYWRIGHT_REUSE_WEB_SERVER !== '0'
    : !process.env.CI;

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    use: {
        baseURL: baseUrl,
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: useWebServer ? {
        command: 'npm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer,
        timeout: 120 * 1000,
        env: {
            NEXT_PUBLIC_API_URL: apiUrl,
            NEXT_PUBLIC_DISABLE_ABLY: disableAbly,
        },
    } : undefined,
});
