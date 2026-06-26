import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getDb } from "@/lib/mongodb";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sign a short-lived JWT access token (15 min).
 */
export function generateAccessToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/**
 * Generate a cryptographically secure opaque refresh token.
 */
export function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

/**
 * Persist a refresh token in the database, associated with a user.
 */
export async function storeRefreshToken(userId, token) {
  const db = await getDb();
  await db.collection("refresh_tokens").insertOne({
    userId: String(userId),
    token,
    used: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
}

/**
 * Rotate a refresh token.
 *
 * - If the token is unknown → return null (reject).
 * - If the token was already used → reuse detected: delete ALL tokens for that
 *   user (session theft mitigation) and return null.
 * - If the token is valid → mark it used, issue a new one, return { userId, refreshToken }.
 */
export async function rotateRefreshToken(oldToken) {
  const db = await getDb();
  const doc = await db.collection("refresh_tokens").findOne({ token: oldToken });

  if (!doc) return null;

  // Replay attack — invalidate the entire session family
  if (doc.used) {
    await db.collection("refresh_tokens").deleteMany({ userId: doc.userId });
    return null;
  }

  if (doc.expiresAt < new Date()) {
    await db.collection("refresh_tokens").deleteOne({ _id: doc._id });
    return null;
  }

  // Consume the old token
  await db.collection("refresh_tokens").updateOne({ _id: doc._id }, { $set: { used: true } });

  // Issue a new refresh token
  const newToken = generateRefreshToken();
  await storeRefreshToken(doc.userId, newToken);

  return { userId: doc.userId, refreshToken: newToken };
}

/**
 * Remove expired refresh tokens — intended for a daily cron or background job.
 */
export async function cleanupExpiredRefreshTokens() {
  const db = await getDb();
  const result = await db.collection("refresh_tokens").deleteMany({
    expiresAt: { $lt: new Date() },
  });
  return result.deletedCount;
}
