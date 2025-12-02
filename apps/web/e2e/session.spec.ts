import { test, expect } from '@playwright/test';

test.describe('Session Management', () => {
    test('should redirect unauthenticated user to login', async ({ page }) => {
        await page.goto('/dashboard');
        // Expect redirect to login
        await expect(page).toHaveURL(/.*login/);
    });
});
