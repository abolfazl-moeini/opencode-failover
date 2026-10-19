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
    expect(headers.get("authorization")).toBe("Bearer key-2")
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
    expect(mockInput.client.tui.showToast).toHaveBeenCalled()
  })
})
