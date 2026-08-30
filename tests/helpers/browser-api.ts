import type { Page } from "@playwright/test";

// Use Chromium's Cookie handling, including Secure cookies on loopback HTTP.
export async function browserApi(page: Page, url: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { url, method, body });
}
export async function browserData(page: Page, url: string) {
  const response = await browserApi(page, url);
  if (response.status !== 200) throw new Error(`Expected authenticated browser response, received ${response.status}`);
  return response.body.data;
}
