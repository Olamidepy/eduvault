import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runIndexerBatch,
  reprocessDeadLetters,
} from "../../src/lib/indexer/stellarIndexer.js";
import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";

function createCollection(failures = {}) {
  const records = new Map();
  return {
    records,
    async findOne(query) {
      if (query._id) return records.get(query._id) || null;
      return null;
    },
    async insertOne(doc) {
      if (failures.insertOne) {
        const key = typeof failures.insertOne === 'function' ? failures.insertOne('insertOne', doc) : failures.insertOne;
        if (key) {
          const error = new Error('transient');
          error.code = 500;
          throw error;
        }
      }
      if (records.has(doc._id)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      records.set(doc._id, doc);
    },
    async updateOne(query, update, options = {}) {
      const key = query._id || `${query.materialId}:${query.buyerAddress || ""}`;
      if (failures.updateOne) {
        const shouldFail = typeof failures.updateOne === 'function' ? failures.updateOne('updateOne', { query, update, options, key }) : failures.updateOne;
        if (shouldFail) {
          const error = new Error('transient-update');
          error.code = 500;
          throw error;
        }
      }
      const current = records.get(key) || {};
      if (!records.has(key) && !options.upsert) return;
      records.set(key, {
        ...current,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
    },
    async deleteOne(query) {
      if (query._id) records.delete(query._id);
    },
  };
}

function createDbWithFailures(failures = {}) {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createCollection(failures[name] || failures));
      return collections.get(name);
    },
  };
}

test('runIndexerBatch records transient failures to dead-letter and supports retries', async () => {
  const failures = {
    // make purchases.updateOne fail the first time by function returning true once
    updateOne: (op, info) => {
      // only fail when key looks like a purchase
      if (info.key && info.key.startsWith('material-1:')) {
        // toggle a flag on the function object
        if (!failures._failedOnce) { failures._failedOnce = true; return true; }
      }
      return false;
    },
  };

  const db = createDbWithFailures({
    [COLLECTIONS.syncEvents]: {},
    [COLLECTIONS.purchases]: failures,
    [COLLECTIONS.entitlementCache]: {},
    [COLLECTIONS.syncState]: {},
    [COLLECTIONS.deadLetterEvents]: {},
  });

  const event = {
    id: 'ledger:tx:1',
    type: 'purchase.completed',
    materialId: 'material-1',
    buyerAddress: 'GBUYER',
    transactionHash: 'tx',
  };

  const result1 = await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [event], nextCursor: null }; } } });
  // operation failed, so nothing applied but dead-letter must be present
  const dl = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' });
  assert(dl, 'dead-letter entry created');
  assert.equal(dl.retryCount, 1);
  assert.equal(dl.status, 'retryable');

  // set retries threshold to 1 so second attempt marks failed
  process.env.INDEXER_MAX_RETRIES = '1';

  const result2 = await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [event], nextCursor: null }; } } });
  const dl2 = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' });
  assert(dl2, 'dead-letter still present');
  assert.equal(dl2.retryCount, 2);
  assert.equal(dl2.status, 'failed');

  // now allow updateOne to succeed by clearing failure flag
  failures._failedOnce = true; // next calls won't fail

  const re = await reprocessDeadLetters(db, { statuses: ['failed', 'retryable'], limit: 10 });
  assert.equal(re.reprocessed.length, 1);
  const dl3 = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' });
  assert.equal(dl3, null);

  // purchases should now contain the upserted record
  const purchaseKey = 'material-1:gbuyer';
  const purchaseRecord = db.collection(COLLECTIONS.purchases).records.get('material-1:gbuyer');
  // buyer address is lowercased in applyIndexedEvent
  assert(purchaseRecord, 'purchase record exists after reprocess');
});
