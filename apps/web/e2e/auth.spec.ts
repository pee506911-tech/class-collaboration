import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
    test('should navigate to login page', async ({ page }) => {
        await page.goto('/login');
        await expect(page.getByRole('heading', { name: /login/i })).toBeVisible();
        await expect(page.getByLabel(/email/i)).toBeVisible();
        await expect(page.getByLabel(/password/i)).toBeVisible();
    });

    test('should navigate to register page', async ({ page }) => {
        await page.goto('/register');
        await expect(page.getByRole('heading', { name: /create an account/i })).toBeVisible();
    });
});
