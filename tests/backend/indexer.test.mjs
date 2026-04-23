import assert from "node:assert/strict";
import { test } from "node:test";

import { applyIndexedEvent, runIndexerBatch } from "../../src/lib/indexer/stellarIndexer.js";

function createCollection() {
  const records = new Map();

  return {
    records,
    async findOne(query) {
      if (query._id) return records.get(query._id) || null;
      return null;
    },
    async insertOne(doc) {
      if (records.has(doc._id)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      records.set(doc._id, doc);
    },
    async updateOne(query, update, options = {}) {
      const key = query._id || `${query.materialId}:${query.buyerAddress || ""}`;
      const current = records.get(key) || {};
      if (!records.has(key) && !options.upsert) return;
      records.set(key, {
        ...current,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
    },
  };
}

function createDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createCollection());
      return collections.get(name);
    },
  };
}

test("applyIndexedEvent writes purchases and entitlement cache idempotently", async () => {
  const db = createDb();
  const event = {
    id: "ledger:tx:1",
    type: "purchase.completed",
    materialId: "material-1",
    buyerAddress: "GBUYER",
    transactionHash: "tx",
  };

  assert.equal((await applyIndexedEvent(db, event)).skipped, false);
  assert.equal((await applyIndexedEvent(db, event)).skipped, true);
});

test("runIndexerBatch stores cursor progress", async () => {
  const db = createDb();
  const result = await runIndexerBatch({
    db,
    eventSource: {
      async getEvents() {
        return { events: [], nextCursor: "cursor-2", lastLedger: 123 };
      },
    },
  });

  assert.deepEqual(result, { applied: 0, skipped: 0, nextCursor: "cursor-2" });
  assert.equal((await db.collection("sync_state").findOne({ _id: "stellar:events" })).cursor, "cursor-2");
});
