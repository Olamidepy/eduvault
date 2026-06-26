import { NextResponse } from "next/server";
import { slidingWindowRateLimit } from "@/lib/rateLimit";

/**
 * Per-route rate limit rules.
 * pattern   — matches against request.nextUrl.pathname
 * limit     — max requests allowed within windowMs
 * windowMs  — sliding window size in milliseconds
 * label     — used as part of the per-IP rate-limit bucket key
 */
const RATE_LIMIT_RULES = [
  // Public marketplace and discovery endpoints — 100 req/min
  {
    pattern: /^\/api\/(market-materials|subjects)(\/|$)/,
    limit: 100,
    windowMs: 60_000,
    label: "marketplace",
  },
  // Creator upload and material-creation endpoints — 5 req/hour
  {
    pattern: /^\/api\/(upload|creator\/materials)(\/|$)/,
    limit: 5,
    windowMs: 60 * 60_000,
    label: "upload",
  },
  // Auth endpoints — 20 req/min to mitigate brute force
  {
    pattern: /^\/api\/auth\//,
    limit: 20,
    windowMs: 60_000,
    label: "auth",
  },
];

function clientIp(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anonymous"
  );
}

export function middleware(request) {
  const { pathname } = request.nextUrl;
  const ip = clientIp(request);

  for (const rule of RATE_LIMIT_RULES) {
    if (!rule.pattern.test(pathname)) continue;

    const result = slidingWindowRateLimit(`${rule.label}:${ip}`, {
      limit: rule.limit,
      windowMs: rule.windowMs,
    });

    const rateLimitHeaders = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetAt),
    };

    if (!result.allowed) {
      return new NextResponse(
        JSON.stringify({
          type: "about:blank",
          title: "Too Many Requests",
          status: 429,
          detail: `Rate limit exceeded. Please retry after ${result.retryAfter} seconds.`,
          instance: pathname,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/problem+json",
            "Retry-After": String(result.retryAfter),
            ...rateLimitHeaders,
          },
        }
      );
    }

    // Pass through with rate limit info headers
    const response = NextResponse.next();
    Object.entries(rateLimitHeaders).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
