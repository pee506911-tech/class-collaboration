import { test, expect } from "@playwright/test";

function buildPublicSessionResponse(token: string) {
  const now = new Date().toISOString();
  const sessionId = "11111111-1111-1111-1111-111111111111";

  return {
    success: true,
    data: {
      id: sessionId,
      creatorId: "user-1",
      title: "Test Session",
      status: "draft",
      shareToken: token,
      currentSlideId: null,
      isResultsVisible: false,
      isPresentationActive: false,
      stateVersion: 1,
      allowQuestions: true,
      requireName: true,
      createdAt: now,
      updatedAt: now,
      slides: [
        {
          id: "slide-1",
          sessionId,
          type: "static",
          content: { title: "Slide 1", body: "Hello" },
          orderIndex: 0,
          isHidden: false,
          stats: { votes: {} },
        },
      ],
      questions: [],
      participants: [],
    },
    error: null,
  };
}

test.describe("Student join resilience", () => {
  test("shows invalid/expired code on 404 and does not navigate", async ({ page }) => {
    await page.route("**/session-by-token/**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, data: null, error: "Session not found" }),
      });
    });

    await page.goto("/student/join");
    await page.getByPlaceholder("e.g. deadbeef").fill("dead-beef");
    await page.getByRole("button", { name: /join/i }).click();

    await expect(page.getByText(/invalid or expired code/i)).toBeVisible();
    await expect(page).toHaveURL(/\/student\/join/);
  });

  test("shows retryable error on network failure, then navigates on retry", async ({ page }) => {
    let callCount = 0;
    await page.route("**/session-by-token/**", async (route) => {
      callCount += 1;
      if (callCount === 1) {
        await route.abort("failed");
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildPublicSessionResponse("deadbeef")),
      });
    });

    await page.goto("/student/join");
    await page.getByPlaceholder("e.g. deadbeef").fill("dead-beef");
    await page.getByRole("button", { name: /join/i }).click();

    await expect(page.getByText(/network error|request timed out|offline/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page).toHaveURL(/\/student\/session\/deadbeef/);
    await expect(page.getByText("Test Session")).toBeVisible();
  });

  test("student session page shows not found on 404", async ({ page }) => {
    await page.route("**/session-by-token/**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, data: null, error: "Session not found" }),
      });
    });

    await page.goto("/student/session/deadbeef");
    await expect(page.getByText(/session not found/i)).toBeVisible();
  });

  test("student session page shows retryable error on network failure", async ({ page }) => {
    await page.route("**/session-by-token/**", async (route) => {
      await route.abort("failed");
    });

    await page.goto("/student/session/deadbeef");
    await expect(page.getByText(/connect right now/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  });
});

