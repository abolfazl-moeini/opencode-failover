import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installFetchPatch, uninstallFetchPatch, registerProvider } from "./lib/fetch-patch.ts"
import { KeyPool } from "./lib/state.ts"

describe("fetch-patch", () => {
  let pool: KeyPool
  let originalFetch: typeof fetch

  beforeEach(() => {
    pool = new KeyPool()
    pool.register("nvidia", {
      keys: ["key-1", "key-2", "key-3"],
      header: "Authorization",
      scheme: "Bearer",
    })
    registerProvider("nvidia", { header: "Authorization", scheme: "Bearer" })
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    uninstallFetchPatch()
    globalThis.fetch = originalFetch
  })

  it("rotates and retries when receiving 429", async () => {
    let callCount = 0
    const keysUsed: string[] = []

    globalThis.fetch = async (req, init) => {
      callCount++
      const auth = (init?.headers as Headers)?.get("Authorization") || ""
      keysUsed.push(auth)

      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "rate limit reached" }), {
          status: 429,
          headers: { "retry-after": "60" },
        })
      }
      return new Response(JSON.stringify({ message: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const mockInput = { client: { tui: { showToast: () => {} } } }
    installFetchPatch(mockInput, pool)

    const response = await fetch("https://api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-1",
      },
      body: JSON.stringify({ prompt: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(callCount).toBe(2)
    expect(keysUsed.length).toBe(2)
    expect(keysUsed[0]).not.toBe(keysUsed[1])

    const status = pool.status("nvidia")
    const quarantined = status.filter((k) => k.status === "quarantined")
    expect(quarantined.length).toBe(1)
  })

  it("disables key on 401 and immediately switches to next key", async () => {
    let callCount = 0
    const keysUsed: string[] = []

    globalThis.fetch = async (req, init) => {
      callCount++
      const auth = (init?.headers as Headers)?.get("Authorization") || ""
      keysUsed.push(auth)

      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "invalid api key" }), {
          status: 401,
        })
      }
      return new Response(JSON.stringify({ message: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const mockInput = { client: { tui: { showToast: () => {} } } }
    installFetchPatch(mockInput, pool)

    const response = await fetch("https://api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-1",
      },
      body: JSON.stringify({ prompt: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(callCount).toBe(2)

    const status = pool.status("nvidia")
    const disabled = status.filter((k) => k.status === "disabled")
    expect(disabled.length).toBe(1)
  })

  it("handles 3 keys where first two hit 429 and third succeeds", async () => {
    let callCount = 0
    const keysUsed: string[] = []

    globalThis.fetch = async (req, init) => {
      callCount++
      const auth = (init?.headers as Headers)?.get("Authorization") || ""
      keysUsed.push(auth)

      if (callCount <= 2) {
        return new Response(JSON.stringify({ error: "rate limit reached" }), {
          status: 429,
          headers: { "retry-after": "60" },
        })
      }
      return new Response(JSON.stringify({ message: "all good" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const mockInput = { client: { tui: { showToast: () => {} } } }
    installFetchPatch(mockInput, pool)

    const response = await fetch("https://api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-1",
      },
      body: JSON.stringify({ prompt: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(callCount).toBe(3)
    const status = pool.status("nvidia")
    const quarantined = status.filter((k) => k.status === "quarantined")
    expect(quarantined.length).toBe(2)
  })
})
