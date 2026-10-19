import type { KeyPool } from "./state.ts"
import { classify, ErrorAction } from "./classify.ts"
import { writeAuthKey, syncCredentialDb } from "./auth.ts"

function safeToast(input: any, message: string, variant: string, duration?: number): void {
  try {
    input?.client?.tui?.showToast({ body: { message, variant, duration: duration ?? 5000 } })
  } catch {}
}

function maskKey(key: string): string {
  if (!key || key.length <= 7) return "<key>"
  return `${key.slice(0, 4)}...${key.slice(-3)}`
}

function resolveProviderFromUrl(urlStr?: string): string | null {
  if (!urlStr) return null
  try {
    const u = new URL(urlStr)
    const host = u.hostname.toLowerCase()
    if (host.includes("opencode.ai")) return "opencode"
    if (host.includes("openrouter.ai")) return "openrouter"
    if (host.includes("anthropic.com")) return "anthropic"
    if (host.includes("openai.com")) return "openai"
    if (host.includes("groq.com")) return "groq"
    if (host.includes("deepseek.com")) return "deepseek"
    if (host.includes("mistral.ai")) return "mistral"
    if (host.includes("together.xyz") || host.includes("together.ai")) return "together"
    if (host.includes("fireworks.ai")) return "fireworks"
    if (host.includes("perplexity.ai")) return "perplexity"
    if (host.includes("nvidia.com")) return "nvidia"
    if (host.includes("cloudflare.com")) return "cloudflare"
  } catch {}
  return null
}

function extractProviderID(event: any): string | null {
  if (!event) return null
  if (typeof event.model?.providerID === "string") return event.model.providerID.toLowerCase()
  if (typeof event.model?.provider === "string") return event.model.provider.toLowerCase()
  if (typeof event.model?.ref === "string" && event.model.ref.includes("/")) {
    return event.model.ref.split("/")[0].toLowerCase()
  }
  if (event.request?.url) {
    const fromUrl = resolveProviderFromUrl(event.request.url)
    if (fromUrl) return fromUrl
  }
  return null
}

function applyAuthToHeaders(headers: Headers, providerID: string, key: string): void {
  const norm = providerID.toLowerCase()
  if (norm === "anthropic") {
    headers.set("x-api-key", key)
  } else if (norm === "google" || norm.includes("gemini")) {
    headers.set("x-goog-api-key", key)
  } else {
    headers.set("authorization", `Bearer ${key}`)
  }
}

export function installOpenCodeHooks(input: any, pool: KeyPool): void {
  if (!input?.session?.hook || typeof input.session.hook !== "function") return

  // 1. Intercept outgoing model HTTP requests to inject the current active key
  input.session.hook("http.request", async (event: any) => {
    try {
      const providerID = extractProviderID(event)
      if (!providerID || !pool.hasProvider(providerID)) return

      const activeKey = pool.pick(providerID)
      if (!activeKey) return

      if (event.request?.headers && typeof event.request.headers.set === "function") {
        applyAuthToHeaders(event.request.headers, providerID, activeKey)
      }

      try { writeAuthKey(providerID, activeKey) } catch {}
      try { syncCredentialDb(providerID, activeKey) } catch {}
    } catch {}
  })

  // 2. Intercept incoming model HTTP responses to catch rate limit / auth errors
  input.session.hook("http.response", async (event: any) => {
    try {
      const status = event.response?.status
      if (!status) return

      const providerID = extractProviderID(event)
      if (!providerID || !pool.hasProvider(providerID)) return

      let body = ""
      if (status >= 400 || status === 200) {
        try {
          body = await event.response.clone().text()
        } catch {}
      }

      const classification = classify({
        statusCode: status,
        responseBody: body,
        message: body.slice(0, 300),
      })

      if (classification.action === ErrorAction.Ignore && status < 400) return

      // Identify the key that was sent
      let failedKey = ""
      if (event.request?.headers && typeof event.request.headers.get === "function") {
        const authHdr = event.request.headers.get("authorization") || ""
        const apiKeyHdr = event.request.headers.get("x-api-key") || event.request.headers.get("api-key") || ""
        const poolKeys = pool.status(providerID)
        for (const k of poolKeys) {
          if (authHdr.includes(k.key) || apiKeyHdr === k.key) {
            failedKey = k.key
            break
          }
        }
      }
      if (!failedKey) {
        failedKey = pool.getCurrentKey(providerID) ?? ""
      }

      if (
        classification.action === ErrorAction.Rotate ||
        classification.action === ErrorAction.Overload ||
        status === 429
      ) {
        if (failedKey) {
          pool.quarantine(providerID, failedKey, classification.retryAfterMs, classification.reason)
        }
        if (pool.hasAvailableKey(providerID)) {
          const nextKey = pool.pick(providerID)
          try { writeAuthKey(providerID, nextKey) } catch {}
          try { syncCredentialDb(providerID, nextKey) } catch {}
          safeToast(
            input,
            `opencode-failover: [${providerID}] limit reached (${classification.reason}). Rotated to key ${maskKey(nextKey)}.`,
            "warning",
          )
        } else {
          safeToast(input, `opencode-failover: All keys exhausted for ${providerID}.`, "error")
        }
      } else if (classification.action === ErrorAction.Disable) {
        if (failedKey) {
          pool.disable(providerID, failedKey, classification.reason)
        }
        if (pool.hasAvailableKey(providerID)) {
          const nextKey = pool.pick(providerID)
          try { writeAuthKey(providerID, nextKey) } catch {}
          try { syncCredentialDb(providerID, nextKey) } catch {}
          safeToast(
            input,
            `opencode-failover: [${providerID}] key disabled (${classification.reason}). Switched to ${maskKey(nextKey)}.`,
            "error",
          )
        } else {
          safeToast(input, `opencode-failover: All keys disabled for ${providerID}.`, "error")
        }
      }
    } catch {}
  })

  // 3. Retry hook: when turn execution errors (e.g. FreeUsageLimitError, QuotaExceeded), force OpenCode to retry
  input.session.hook("retry", async (event: any) => {
    try {
      const providerID = extractProviderID(event)
      if (!providerID || !pool.hasProvider(providerID)) return

      if (pool.hasAvailableKey(providerID)) {
        const nextKey = pool.pick(providerID)
        try { writeAuthKey(providerID, nextKey) } catch {}
        try { syncCredentialDb(providerID, nextKey) } catch {}

        event.decision = {
          retry: true,
          delay: 100,
        }
      } else {
        event.decision = { retry: false }
        safeToast(input, `opencode-failover: Cannot retry — all keys exhausted for ${providerID}.`, "error")
      }
    } catch {}
  })
}
