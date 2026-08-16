import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

const target = process.env.WENXIAN_WEB_URL ?? "https://wenxian.njzjz.win/";
const expectedVersion = process.env.EXPECTED_WENXIAN_VERSION ?? "0.3.3";
const cases = [
  "10.1063/5.0155600",
  "37526163",
  "2304.09409",
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let workerSource = await readFile(
  new URL("../docs/webworker.js", import.meta.url),
  "utf8",
);
if (process.env.WENXIAN_WHEEL_URL) {
  const installLine =
    'await micropip.install(["wenxian", "pylatexenc==3.0a21"]);';
  if (!workerSource.includes(installLine)) {
    throw new Error("could not locate the wenxian installation line");
  }
  workerSource = workerSource.replace(
    installLine,
    `await micropip.install([${JSON.stringify(process.env.WENXIAN_WHEEL_URL)}, "pylatexenc==3.0a21"]);`,
  );
}
if (process.env.DISABLE_LEGACY_SHIM === "1") {
  workerSource = workerSource.replace(
    "  installLegacyWenxianBrowserShims();",
    "  // Legacy shim disabled for branch-wheel validation.",
  );
}
await context.route("**/webworker.js", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: workerSource,
  }),
);
const page = await context.newPage();
const workers = [];
const nativeLimiterRequests = [];

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
    /(?:pyrate[-_]limiter|requests[-_]ratelimiter)/i.test(url)
  ) {
    nativeLimiterRequests.push(url);
  }
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
  if (installedVersion !== expectedVersion) {
    throw new Error(
      `expected wenxian ${expectedVersion}, loaded ${installedVersion ?? "unknown"}`,
    );
  }
  if (
    process.env.EXPECT_NO_NATIVE_LIMITERS === "1" &&
    nativeLimiterRequests.length > 0
  ) {
    throw new Error(
      `browser requested native-only limiter packages: ${nativeLimiterRequests.join(", ")}`,
    );
  }
} catch (error) {
  await page.screenshot({ path: "web-smoke.png", fullPage: true });
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
