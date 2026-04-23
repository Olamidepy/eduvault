import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRateLimit, resetRateLimits } from "../../src/lib/api/rateLimit.js";

test("checkRateLimit blocks after the configured request limit", () => {
  resetRateLimits();

  assert.equal(checkRateLimit("profile:local", { limit: 2, now: 1000 }).allowed, true);
  assert.equal(checkRateLimit("profile:local", { limit: 2, now: 1001 }).allowed, true);

  const blocked = checkRateLimit("profile:local", { limit: 2, now: 1002 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 60);
});
