import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

const target = process.env.WENXIAN_WEB_URL ?? "https://wenxian.njzjz.win/";
const cases = [
  "10.1063/5.0155600",
  "37526163",
  "2304.09409",
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const workerSource = await readFile(
  new URL("../docs/webworker.js", import.meta.url),
  "utf8",
);
await context.route("**/webworker.js", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: workerSource,
  }),
);
const page = await context.newPage();
const workers = [];

page.on("console", (message) => {
  console.log(`[console:${message.type()}] ${message.text()}`);
});
page.on("pageerror", (error) => {
  console.error(`[pageerror] ${error.stack ?? error.message}`);
});
page.on("worker", (worker) => {
  workers.push(worker);
  console.log(`[worker] ${worker.url()}`);
});
context.on("requestfailed", (request) => {
  console.error(
    `[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
  );
});
context.on("response", (response) => {
  const url = response.url();
  if (
    response.status() >= 400 ||
    /(?:pypi|pythonhosted|crossref|ncbi|europepmc|arxiv|datacite|semanticscholar)/i.test(
      url,
    )
  ) {
    console.log(`[response:${response.status()}] ${url}`);
  }
});

try {
  const url = new URL(target);
  url.searchParams.set("smoke", Date.now().toString());
  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  for (const identifier of cases) {
    console.log(`[case] ${identifier}`);
    await page.locator("#identifier").fill(identifier);
    await page.locator("#submit").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent !== "Fetching...",
      undefined,
      { timeout: 180_000 },
    );

    const message = (await page.locator("#message").textContent())?.trim() ?? "";
    const bibtex = (await page.locator("#bibtex").textContent())?.trim() ?? "";
    console.log(`[result] message=${JSON.stringify(message)}`);
    console.log(`[result] bibtex=${JSON.stringify(bibtex)}`);

    if (message) {
      throw new Error(`${identifier}: ${message}`);
    }
    if (!bibtex.startsWith("@")) {
      throw new Error(`${identifier}: no BibTeX entry was returned`);
    }
  }

  let installedVersion = null;
  for (const worker of workers) {
    try {
      installedVersion = await worker.evaluate(() =>
        self.pyodide
          ? self.pyodide.runPython(
              'from importlib.metadata import version\nversion("wenxian")',
            )
          : null,
      );
      if (installedVersion) break;
    } catch (error) {
      console.error(`[worker-evaluate] ${error}`);
    }
  }
  console.log(`[wenxian-version] ${installedVersion ?? "unknown"}`);
  if (installedVersion !== "0.3.3") {
    throw new Error(
      `expected wenxian 0.3.3, loaded ${installedVersion ?? "unknown"}`,
    );
  }
} catch (error) {
  await page.screenshot({ path: "web-smoke.png", fullPage: true });
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
