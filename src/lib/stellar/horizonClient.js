import { Horizon } from '@stellar/stellar-sdk';
import { HORIZON_URL, isMainnet } from '@/lib/config/chain';
import logger from '@/lib/logger';

// Primary URL from config; fallback list ordered by preference.
const PRIMARY_URL = HORIZON_URL;

const FALLBACK_URLS = isMainnet
  ? [
      'https://horizon.stellar.org',
      'https://horizon.stellar.lobstr.co',
    ]
  : [
      'https://horizon-testnet.stellar.org',
    ];

// Gather any extra endpoints defined in env (space or comma separated).
const EXTRA_FALLBACKS = (process.env.STELLAR_HORIZON_FALLBACKS || '')
  .split(/[\s,]+/)
  .map((u) => u.trim())
  .filter(Boolean);

const ALL_ENDPOINTS = [
  PRIMARY_URL,
  ...EXTRA_FALLBACKS,
  ...FALLBACK_URLS,
].filter((url, idx, arr) => url && arr.indexOf(url) === idx);

const DEFAULT_TIMEOUT_MS = Number(process.env.STELLAR_HORIZON_TIMEOUT_MS || 8000);
const DEFAULT_RETRIES = Number(process.env.STELLAR_HORIZON_RETRIES || 2);

function buildServer(url) {
  return new Horizon.Server(url, { allowHttp: url.startsWith('http://') });
}

function isTransientError(error) {
  const status = error?.response?.status ?? error?.status;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  const code = error?.code || '';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('timeout') || message.includes('network') || message.includes('socket');
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Horizon request timed out (${ms}ms) for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute `fn(server)` against each endpoint in order, switching to the next
 * node on connection or timeout errors.  Logs each failover so operators can
 * triage node health from the dashboard alerts.
 *
 * @param {(server: Horizon.Server) => Promise<T>} fn
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withFailover(fn, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = {}) {
  const errors = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = ALL_ENDPOINTS[attempt % ALL_ENDPOINTS.length];
    const server = buildServer(url);

    try {
      const result = await withTimeout(fn(server), timeoutMs, url);

      if (attempt > 0) {
        logger.info({ failoverUrl: url, attempt }, 'Horizon failover succeeded');
      }
      return result;
    } catch (err) {
      errors.push({ url, message: err.message });

      if (!isTransientError(err)) {
        logger.warn({ url, err: err.message }, 'Horizon non-transient error — not failing over');
        throw err;
      }

      logger.warn(
        { primaryUrl: ALL_ENDPOINTS[0], failoverUrl: url, attempt, err: err.message },
        'Horizon connection drop detected — switching to next node'
      );
    }
  }

  const summary = errors.map((e) => `${e.url}: ${e.message}`).join(' | ');
  throw new Error(`All Horizon endpoints failed after ${retries + 1} attempts. Errors: ${summary}`);
}

/**
 * Convenience wrapper: load a Stellar account with failover support.
 *
 * @param {string} publicKey
 * @returns {Promise<Horizon.AccountResponse>}
 */
export async function loadAccount(publicKey) {
  return withFailover((server) => server.loadAccount(publicKey));
}

/**
 * Submit a signed transaction with failover support.
 *
 * @param {import('@stellar/stellar-sdk').Transaction} transaction
 * @returns {Promise<Horizon.HorizonApi.SubmitTransactionResponse>}
 */
export async function submitTransaction(transaction) {
  return withFailover((server) => server.submitTransaction(transaction));
}

/**
 * Fetch fee statistics from the primary Horizon endpoint.
 * Used by surge pricing detection (issue #385).
 *
 * @returns {Promise<Horizon.HorizonApi.FeeStatsResponse>}
 */
export async function fetchFeeStats() {
  return withFailover((server) => server.feeStats());
}

/**
 * Return the list of all configured Horizon endpoints (primary + fallbacks)
 * for diagnostics / health checks.
 */
export function getConfiguredEndpoints() {
  return [...ALL_ENDPOINTS];
}
