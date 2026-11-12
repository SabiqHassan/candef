/** OWNER ONLY. Never enabled by CI. Fetch metadata only, no rows or source captures. */
import { CkanClient } from "./client";
import { discoverResource, PACKAGE_TITLES } from "./resources";

if (process.env.CANDEF_LIVE_API !== "1") {
  console.log("Skipped: owner must set CANDEF_LIVE_API=1 and pass --terms-reviewed");
} else if (process.env.CI) {
  console.error("Live API smoke is owner-only and refuses CI");
  process.exitCode = 1;
} else {
  const client = new CkanClient({ termsReviewed: process.argv.includes("--terms-reviewed") });
  try {
    for (const kind of ["contracts", "grants"] as const) {
      const packageId = await client.findPackage(PACKAGE_TITLES[kind]);
      const resource = await discoverResource(client, kind, packageId);
      console.log(JSON.stringify({ kind, ...resource }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Smoke failed; response body withheld");
    process.exitCode = 1;
  }
}
