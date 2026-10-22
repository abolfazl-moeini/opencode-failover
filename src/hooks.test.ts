import { describe, it, expect, beforeEach, mock } from "bun:test"
import { KeyPool } from "./lib/state.ts"
import { installOpenCodeHooks } from "./lib/hooks.ts"

describe("OpenCode v2 Native Session Hooks", () => {
  let pool: KeyPool
  let hooks: Record<string, (event: any) => Promise<void>>
  let mockInput: any

  beforeEach(() => {
    pool = new KeyPool()
    pool.register("opencode", {
      keys: ["key-1", "key-2", "key-3"],
      header: "Authorization",
      scheme: "Bearer",
    })

    hooks = {}
    mockInput = {
      session: {
        hook: mock((name: string, callback: any) => {
          hooks[name] = callback
        }),
      },
      client: {
        tui: {
          showToast: mock(() => {}),
        },
      },
    }

    installOpenCodeHooks(mockInput, pool)
  })

  it("registers http.request, http.response, and retry hooks", () => {
    expect(mockInput.session.hook).toHaveBeenCalledTimes(3)
    expect(hooks["http.request"]).toBeDefined()
    expect(hooks["http.response"]).toBeDefined()
    expect(hooks["retry"]).toBeDefined()
  })

  it("injects current active key into http.request headers", async () => {
    const headers = new Headers()
    const event = {
      model: { providerID: "opencode", modelID: "glm-5.3-flash-free" },
      request: {
        url: "https://opencode.ai/api/v2/chat",
        headers,
      },
    }

    await hooks["http.request"](event)
    expect(headers.get("authorization")).toBe("Bearer key-1")
  })

  it("injects x-opencode-org-id when cached for opencode key", async () => {
    const { opencodeOrgCache } = await import("./lib/hooks.ts")
    opencodeOrgCache.set("key-1", "org_test_123")

    const headers = new Headers()
    const event = {
      model: { providerID: "opencode", modelID: "glm-5.3-flash-free" },
      request: {
        url: "https://opencode.ai/api/v2/chat",
        headers,
      },
    }

    await hooks["http.request"](event)
    expect(headers.get("authorization")).toBe("Bearer key-1")
    expect(headers.get("x-opencode-org-id")).toBe("org_test_123")
    expect(headers.get("x-org-id")).toBe("org_test_123")
  })

  it("quarantines key and switches to next key on 429 response", async () => {
    const reqHeaders = new Headers({ authorization: "Bearer key-1" })
    const resHeaders = new Headers({ "retry-after-ms": "5000" })

    const response = new Response(
      JSON.stringify({
        type: "error",
        error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." },
      }),
      { status: 429, headers: resHeaders },
    )

    const event = {
      model: { providerID: "opencode" },
      request: { headers: reqHeaders },
      response,
    }

    await hooks["http.response"](event)

    const status = pool.status("opencode")
    expect(status[0]!.status).toBe("quarantined")
    expect(status[0]!.consecutiveErrors).toBe(1)
    expect(pool.getCurrentKey("opencode")).toBe("key-2")
    expect(mockInput.client.tui.showToast).toHaveBeenCalled()
  })

  it("overrides retry decision to true when available keys remain in pool", async () => {
    const event = {
      model: { ref: "opencode/glm-5.3-flash-free" },
      error: {
        name: "AI.Error.QuotaExceeded",
        message: "Rate limit exceeded. Please try again later.",
      },
      attempt: 1,
      decision: { retry: false, delay: 0 },
    }

    await hooks["retry"](event)

    expect(event.decision.retry).toBe(true)
    expect(event.decision.delay).toBe(100)
    // Should have picked next key
    expect(pool.getCurrentKey("opencode")).toBe("key-2")
  })

  it("sets retry decision to false when all keys in pool are disabled or exhausted", async () => {
    pool.disable("opencode", "key-1", "exhausted")
    pool.disable("opencode", "key-2", "exhausted")
    pool.disable("opencode", "key-3", "exhausted")

    const event = {
      model: { providerID: "opencode" },
      error: {
        name: "AI.Error.QuotaExceeded",
        message: "Rate limit exceeded.",
      },
      attempt: 1,
      decision: { retry: false, delay: 0 },
    }

    await hooks["retry"](event)

    expect(event.decision.retry).toBe(false)
    expect(event.error.type).toBe("failover.exhausted")
    expect(event.error.message).toContain("All 3 keys for provider \"opencode\" were attempted")
    expect(mockInput.client.tui.showToast).toHaveBeenCalled()
  })

  it("prevents double-installation of hooks on the same session", () => {
    installOpenCodeHooks(mockInput, pool)
    installOpenCodeHooks(mockInput, pool)
    // Should still only have been called 3 times total from the initial setup
    expect(mockInput.session.hook).toHaveBeenCalledTimes(3)
  })

  it("does not skip keys when http.response and retry fire in sequence", async () => {
    // Attempt 1: Request sent with Key 1
    const req1 = { headers: new Headers({ authorization: "Bearer key-1" }) }
    await hooks["http.request"]({ model: { providerID: "opencode" }, request: req1 })

    // Response returns 429
    const res1 = new Response(JSON.stringify({ error: { type: "FreeUsageLimitError" } }), { status: 429 })
    await hooks["http.response"]({ model: { providerID: "opencode" }, request: req1, response: res1 })
    
    // Key 1 is now quarantined. Next active key should be key-2:
    expect(pool.getActiveKey("opencode")).toBe("key-2")

    // Retry hook runs for attempt 1
    const retry1 = {
      model: { providerID: "opencode" },
      error: { type: "provider.free-limit", message: "Free usage limit reached." },
      attempt: 1,
      decision: { retry: false, delay: 0 },
    }
    await hooks["retry"](retry1)
    expect(retry1.decision.retry).toBe(true)
    // Key-2 should NOT have been skipped!
    expect(pool.getActiveKey("opencode")).toBe("key-2")

    // Attempt 2: Request sent with Key 2
    const req2 = { headers: new Headers({ authorization: "Bearer key-2" }) }
    await hooks["http.request"]({ model: { providerID: "opencode" }, request: req2 })

    const res2 = new Response(JSON.stringify({ error: { type: "FreeUsageLimitError" } }), { status: 429 })
    await hooks["http.response"]({ model: { providerID: "opencode" }, request: req2, response: res2 })
    expect(pool.getActiveKey("opencode")).toBe("key-3")

    const retry2 = {
      model: { providerID: "opencode" },
      error: { type: "provider.free-limit", message: "Free usage limit reached." },
      attempt: 2,
      decision: { retry: false, delay: 0 },
    }
    await hooks["retry"](retry2)
    expect(retry2.decision.retry).toBe(true)
    expect(pool.getActiveKey("opencode")).toBe("key-3")

    // Attempt 3: Request sent with Key 3
    const req3 = { headers: new Headers({ authorization: "Bearer key-3" }) }
    await hooks["http.request"]({ model: { providerID: "opencode" }, request: req3 })

    const res3 = new Response(JSON.stringify({ error: { type: "FreeUsageLimitError" } }), { status: 429 })
    await hooks["http.response"]({ model: { providerID: "opencode" }, request: req3, response: res3 })

    const retry3 = {
      model: { providerID: "opencode" },
      error: { type: "provider.free-limit", message: "Free usage limit reached." },
      attempt: 3,
      decision: { retry: false, delay: 0 },
    }
    await hooks["retry"](retry3)
    // All 3 keys are exhausted now
    expect(retry3.decision.retry).toBe(false)
    expect(retry3.error.type).toBe("failover.exhausted")
    expect(retry3.error.message).toContain("All 3 keys for provider \"opencode\" were attempted and are exhausted/quarantined")
  })

  it("resets consecutiveErrors on 200 success response", async () => {
    // Force 1 error on key-1
    pool.quarantine("opencode", "key-1", 100, "temp error")
    expect(pool.status("opencode")[0]!.consecutiveErrors).toBe(1)

    // Receive a 200 response with key-1
    const req = { headers: new Headers({ authorization: "Bearer key-1" }) }
    const res = new Response("OK", { status: 200 })
    await hooks["http.response"]({ model: { providerID: "opencode" }, request: req, response: res })

    expect(pool.status("opencode")[0]!.consecutiveErrors).toBe(0)
  })
})
