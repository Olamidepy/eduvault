import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sanitizeObject,
  validateMaterialPayload,
  validateProfilePayload,
} from "../../src/lib/api/validation.js";

test("validateProfilePayload normalizes and sanitizes profile input", () => {
  const profile = validateProfilePayload({
    fullName: "  Ada Creator  ",
    email: "ADA@EXAMPLE.COM ",
    walletAddress: "0x0000000000000000000000000000000000000001",
    bio: "hello\u0000world",
  });

  assert.equal(profile.fullName, "Ada Creator");
  assert.equal(profile.email, "ada@example.com");
  assert.equal(profile.bio, "helloworld");
  assert.equal(profile.walletAddressLower, "0x0000000000000000000000000000000000000001");
});

test("validateMaterialPayload rejects invalid price and unknown visibility", () => {
  assert.throws(
    () => validateMaterialPayload({ title: "Notes", fileUrl: "ipfs://file", price: -1 }),
    /Invalid price/
  );
  assert.throws(
    () =>
      validateMaterialPayload({
        title: "Notes",
        fileUrl: "ipfs://file",
        visibility: "everyone",
      }),
    /Invalid visibility/
  );
});

test("sanitizeObject strips control characters from stored metadata", () => {
  assert.deepEqual(sanitizeObject({ title: "  Math\u0000 Notes " }), { title: "Math Notes" });
});
