import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { KeyPool } from "./lib/state.ts"
import { classify, ErrorAction } from "./lib/classify.ts"
import { getHeader, setHeader, installOpenCodeHooks, applyAuthToHeaders, opencodeOrgCache } from "./lib/hooks.ts"
import { writeAuthKey, readAuth, removeAuthKey } from "./lib/auth.ts"

describe("Edge Cases & Code Review Audits", () => {
  beforeEach(() => {
    opencodeOrgCache.clear()
  })

  describe("Classification Edge Cases", () => {
    it("treats 402 Payment Required as Rotate (not permanent Disable)", () => {
      const result = classify({
        statusCode: 402,
        responseBody: JSON.stringify({ error: { message: "Upstream request failed: Insufficient account funds" } }),
      })
      expect(result.action).toBe(ErrorAction.Rotate)
      expect(result.reason).toContain("HTTP 402")
      expect(result.retryAfterMs).toBeGreaterThan(0)
    })

    it("treats 403 FreeTierError as Rotate", () => {
      const result = classify({
        statusCode: 403,
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "FreeTierError",
            message: "OpenCode's free tier can only be used from within OpenCode.",
          },
        }),
      })
      expect(result.action).toBe(ErrorAction.Rotate)
      expect(result.reason.toLowerCase()).toMatch(/free.*tier/)
    })

    it("treats 403 Workspace access denied as Rotate", () => {
      const result = classify({
        statusCode: 403,
        message: "Error: Workspace access denied",
      })
      expect(result.action).toBe(ErrorAction.Rotate)
      expect(result.reason).toContain("Workspace access mismatch")
    })

    it("disables keys on true 401 Authentication Failure", () => {
      const result = classify({
        statusCode: 401,
        responseBody: JSON.stringify({ error: "Invalid API key" }),
      })
      expect(result.action).toBe(ErrorAction.Disable)
      expect(result.reason).toContain("HTTP 401")
    })

    it("handles empty response bodies and HTML Cloudflare 502 gracefully", () => {
      const html502 = classify({
        statusCode: 502,
        responseBody: "<html><head><title>502 Bad Gateway</title></head><body>Cloudflare</body></html>",
      })
      expect(html502.action).toBe(ErrorAction.Rotate)

      const emptyBody = classify({
        statusCode: 500,
        responseBody: "",
      })
      expect(emptyBody.action).toBe(ErrorAction.Rotate)
    })
  })

  describe("Header Utilities Edge Cases", () => {
    it("handles Headers Web API object", () => {
      const h = new Headers()
      setHeader(h, "Authorization", "Bearer test-key")
      expect(getHeader(h, "authorization")).toBe("Bearer test-key")
      expect(getHeader(h, "AUTHORIZATION")).toBe("Bearer test-key")
    })

    it("handles plain JS Record<string, string> objects case-insensitively", () => {
      const h: Record<string, string> = { "x-api-key": "secret-123" }
      expect(getHeader(h, "X-API-KEY")).toBe("secret-123")
      setHeader(h, "Authorization", "Bearer plain-key")
      expect(getHeader(h, "authorization")).toBe("Bearer plain-key")
    })

    it("handles tuple array headers [string, string][]", () => {
      const h: [string, string][] = [["content-type", "application/json"]]
      setHeader(h, "Authorization", "Bearer tuple-key")
      expect(getHeader(h, "authorization")).toBe("Bearer tuple-key")
      setHeader(h, "authorization", "Bearer updated-key")
      expect(getHeader(h, "AUTHORIZATION")).toBe("Bearer updated-key")
    })

    it("safely handles null / undefined headers without throwing", () => {
      expect(getHeader(null, "authorization")).toBeNull()
      expect(getHeader(undefined, "authorization")).toBeNull()
      expect(() => setHeader(null, "authorization", "key")).not.toThrow()
    })
  })

  describe("KeyPool getActiveKey() stability", () => {
    it("does not advance round-robin index on repeated getActiveKey calls", () => {
      const pool = new KeyPool()
      pool.register("testprov", { keys: ["key-1", "key-2", "key-3"], header: "authorization", scheme: "Bearer" })

      const first = pool.getActiveKey("testprov")
      const second = pool.getActiveKey("testprov")
      const third = pool.getActiveKey("testprov")

      expect(first).toBe(second)
      expect(second).toBe(third)
    })

    it("switches to next active key if current key is quarantined", () => {
      const pool = new KeyPool()
      pool.register("testprov", { keys: ["key-A", "key-B"], header: "authorization", scheme: "Bearer" })

      const current = pool.getActiveKey("testprov")
      expect(current).toBe("key-A")

      pool.quarantine("testprov", "key-A", 10_000, "Rate limited")
      const next = pool.getActiveKey("testprov")
      expect(next).toBe("key-B")
    })

    it("computes earliest quarantine expiry accurately", () => {
      const pool = new KeyPool()
      pool.register("testprov", { keys: ["key-1", "key-2"], header: "authorization", scheme: "Bearer" })

      expect(pool.getEarliestQuarantineExpiry("testprov")).toBeNull()

      const now = Date.now()
      pool.quarantine("testprov", "key-1", 5_000, "rate limit")
      pool.quarantine("testprov", "key-2", 20_000, "rate limit")

      const earliest = pool.getEarliestQuarantineExpiry("testprov")
      expect(earliest).not.toBeNull()
      expect(earliest!).toBeGreaterThanOrEqual(now + 4000)
      expect(earliest!).toBeLessThanOrEqual(now + 6000)
    })
  })

  describe("Session Hooks Robustness", () => {
    it("tags outgoing request and correctly associates failure in http.response", async () => {
      const pool = new KeyPool()
      pool.register("opencode", { keys: ["key-1", "key-2"], header: "authorization", scheme: "Bearer" })

      const registeredHooks = new Map<string, Function>()
      const mockSession = {
        hook: (name: string, fn: Function) => registeredHooks.set(name, fn),
      }

      installOpenCodeHooks({ session: mockSession }, pool)

      const requestHook = registeredHooks.get("http.request")!
      const responseHook = registeredHooks.get("http.response")!

      const fakeReq: any = {
        url: "https://opencode.ai/inference/openai/v1/chat/completions",
        headers: {},
      }

      await requestHook({
        request: fakeReq,
        model: { providerID: "opencode" },
      })

      expect(fakeReq.__failover_key).toBe("key-1")
      expect(getHeader(fakeReq.headers, "authorization")).toBe("Bearer key-1")

      // Now simulate 429 response
      await responseHook({
        request: fakeReq,
        response: {
          status: 429,
          clone: () => ({ text: async () => JSON.stringify({ error: "rate limit" }) }),
        },
        model: { providerID: "opencode" },
      })

      // key-1 should be quarantined, key-2 should now be active
      const status = pool.status("opencode")
      expect(status.find((k) => k.key === "key-1")?.status).toBe("quarantined")
      expect(pool.getActiveKey("opencode")).toBe("key-2")
    })

    it("retry hook delays turn execution when all keys are quarantined with short backoff", async () => {
      const pool = new KeyPool()
      pool.register("opencode", { keys: ["key-1"], header: "authorization", scheme: "Bearer" })

      const registeredHooks = new Map<string, Function>()
      installOpenCodeHooks({ session: { hook: (n: string, f: Function) => registeredHooks.set(n, f) } }, pool)

      // Quarantine key-1 for 2 seconds
      pool.quarantine("opencode", "key-1", 2000, "rate limit")

      const retryHook = registeredHooks.get("retry")!
      const retryEvent: any = {
        model: { providerID: "opencode" },
        error: new Error("Rate limit exceeded"),
        decision: {},
      }

      await retryHook(retryEvent)

      expect(retryEvent.decision.retry).toBe(true)
      expect(retryEvent.decision.delay).toBeGreaterThanOrEqual(200)
      expect(retryEvent.decision.delay).toBeLessThanOrEqual(3000)
    })
  })
})
