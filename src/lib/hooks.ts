import type { KeyPool } from "./state.ts"
import { classify, ErrorAction } from "./classify.ts"
import { writeAuthKey, syncCredentialDb } from "./auth.ts"
import { getOriginalFetch } from "./fetch-patch.ts"

function safeToast(input: any, message: string, variant: string, duration?: number): void {
  try {
    input?.client?.tui?.showToast({ body: { message, variant, duration: duration ?? 5000 } })
  } catch {}
  try {
    input?.ui?.toast?.show({ message, variant, duration: duration ?? 5000 })
  } catch {}
  try {
    input?.context?.ui?.toast?.show({ message, variant, duration: duration ?? 5000 })
  } catch {}
  console.error(`[opencode-failover] ${message}`)
}

function maskKey(key: string): string {
  if (!key || key.length <= 7) return "<key>"
  return `${key.slice(0, 4)}...${key.slice(-3)}`
}

export function getHeader(headers: any, name: string): string | null {
  if (!headers) return null
  const target = name.toLowerCase()
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(target)
  }
  if (Array.isArray(headers)) {
    const pair = headers.find(([k]: [string, string]) => String(k).toLowerCase() === target)
    return pair ? String(pair[1]) : null
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === target) return String(v)
    }
  }
  return null
}

export function setHeader(headers: any, name: string, value: string): void {
  if (!headers) return
  if (typeof headers.set === "function") {
    headers.set(name, value)
    return
  }
  if (Array.isArray(headers)) {
    const target = name.toLowerCase()
    const idx = headers.findIndex(([k]: [string, string]) => String(k).toLowerCase() === target)
    if (idx >= 0) headers[idx] = [name, value]
    else headers.push([name, value])
    return
  }
  if (typeof headers === "object") {
    headers[name] = value
  }
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

export const opencodeOrgCache = new Map<string, string>()

export async function getOpencodeOrgId(key: string): Promise<string | null> {
  if (!key) return null
  if (opencodeOrgCache.has(key)) return opencodeOrgCache.get(key)!
  try {
    const rawFetch = getOriginalFetch() ?? fetch
    const res = await rawFetch("https://opencode.ai/console/api/v2/config", {
      headers: { authorization: `Bearer ${key}` },
    })
    if (res.ok) {
      const json: any = await res.json()
      const org = json?.providers?.opencode?.headers?.["x-opencode-org-id"]
      if (typeof org === "string" && org.length > 0) {
        opencodeOrgCache.set(key, org)
        return org
      }
    }
  } catch {}
  return null
}

export async function applyAuthToHeaders(headers: any, providerID: string, key: string): Promise<string | null> {
  const norm = providerID.toLowerCase()
  if (norm === "anthropic") {
    setHeader(headers, "x-api-key", key)
    return null
  } else if (norm === "google" || norm.includes("gemini")) {
    setHeader(headers, "x-goog-api-key", key)
    return null
  } else {
    setHeader(headers, "authorization", `Bearer ${key}`)
    if (norm === "opencode") {
      const orgId = await getOpencodeOrgId(key)
      if (orgId) {
        setHeader(headers, "x-opencode-org-id", orgId)
        setHeader(headers, "x-org-id", orgId)
      }
      return orgId
    }
    return null
  }
}

export function installOpenCodeHooks(input: any, pool: KeyPool): void {
  if (!input?.session?.hook || typeof input.session.hook !== "function") return
  if ((input.session as any).__opencode_failover_hooks_installed) return
  ;(input.session as any).__opencode_failover_hooks_installed = true

  const lastAttemptedKey = new Map<string, string>()
  const lastHandledResponseKey = new Map<string, string>()

  // 1. Intercept outgoing model HTTP requests to inject the current active key
  input.session.hook("http.request", async (event: any) => {
    try {
      const providerID = extractProviderID(event)
      if (!providerID || !pool.hasProvider(providerID)) return

      const activeKey = pool.getActiveKey(providerID) ?? pool.getCurrentKey(providerID) ?? pool.pick(providerID)
      if (!activeKey) return

      lastAttemptedKey.set(providerID, activeKey)

      if (event.request && typeof event.request === "object") {
        try {
          ;(event.request as any).__failover_key = activeKey
        } catch {}
      }

      let orgId: string | null = null
      if (event.request?.headers) {
        orgId = await applyAuthToHeaders(event.request.headers, providerID, activeKey)
      }

      try { writeAuthKey(providerID, activeKey, orgId ? { orgID: orgId } : undefined) } catch {}
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

      // Identify the key that was sent
      let failedKey = (event.request as any)?.__failover_key ?? ""
      if (!failedKey && event.request?.headers) {
        const authHdr = getHeader(event.request.headers, "authorization") || ""
        const apiKeyHdr = getHeader(event.request.headers, "x-api-key") || getHeader(event.request.headers, "api-key") || ""
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

      if (status >= 200 && status < 300) {
        if (failedKey) {
          try { pool.recordSuccess(providerID, failedKey) } catch {}
        }
        return
      }

      let body = ""
      if (status >= 400) {
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

      if (
        classification.action === ErrorAction.Rotate ||
        classification.action === ErrorAction.Overload ||
        status === 429
      ) {
        if (failedKey) {
          lastHandledResponseKey.set(providerID, failedKey)
          pool.quarantine(providerID, failedKey, classification.retryAfterMs, classification.reason)
        }
        if (pool.hasAvailableKey(providerID)) {
          const nextKey = pool.getActiveKey(providerID) ?? pool.pick(providerID)
          const nextOrg = providerID.toLowerCase() === "opencode" ? await getOpencodeOrgId(nextKey) : null
          try { writeAuthKey(providerID, nextKey, nextOrg ? { orgID: nextOrg } : undefined) } catch {}
          try { syncCredentialDb(providerID, nextKey) } catch {}
          safeToast(
            input,
            `[${providerID}] limit reached (${classification.reason}). Rotated to key ${maskKey(nextKey)}.`,
            "warning",
          )
        } else {
          safeToast(input, `All keys exhausted for ${providerID}.`, "error")
        }
      } else if (classification.action === ErrorAction.Disable) {
        if (failedKey) {
          lastHandledResponseKey.set(providerID, failedKey)
          pool.disable(providerID, failedKey, classification.reason)
        }
        if (pool.hasAvailableKey(providerID)) {
          const nextKey = pool.getActiveKey(providerID) ?? pool.pick(providerID)
          const nextOrg = providerID.toLowerCase() === "opencode" ? await getOpencodeOrgId(nextKey) : null
          try { writeAuthKey(providerID, nextKey, nextOrg ? { orgID: nextOrg } : undefined) } catch {}
          try { syncCredentialDb(providerID, nextKey) } catch {}
          safeToast(
            input,
            `[${providerID}] key disabled (${classification.reason}). Switched to ${maskKey(nextKey)}.`,
            "error",
          )
        } else {
          safeToast(input, `All keys disabled for ${providerID}.`, "error")
        }
      }
    } catch {}
  })

  // 3. Retry hook: when turn execution errors (e.g. FreeUsageLimitError, QuotaExceeded), force OpenCode to retry
  input.session.hook("retry", async (event: any) => {
    try {
      const providerID = extractProviderID(event)
      if (!providerID || !pool.hasProvider(providerID)) return

      const attempted = lastAttemptedKey.get(providerID) ?? pool.getCurrentKey(providerID)
      const handled = lastHandledResponseKey.get(providerID)

      if (attempted && handled !== attempted) {
        const status = pool.status(providerID).find((k) => k.key === attempted)
        if (status && status.status === "active") {
          const classification = classify(event.error)
          if (classification.action === ErrorAction.Disable) {
            pool.disable(providerID, attempted, classification.reason)
          } else {
            pool.quarantine(providerID, attempted, classification.retryAfterMs, classification.reason)
          }
          lastHandledResponseKey.set(providerID, attempted)
        }
      }

      if (pool.hasAvailableKey(providerID)) {
        const nextKey = pool.getActiveKey(providerID) ?? pool.getCurrentKey(providerID)
        if (nextKey) {
          const nextOrg = providerID.toLowerCase() === "opencode" ? await getOpencodeOrgId(nextKey) : null
          try { writeAuthKey(providerID, nextKey, nextOrg ? { orgID: nextOrg } : undefined) } catch {}
          try { syncCredentialDb(providerID, nextKey) } catch {}
        }

        event.decision = {
          retry: true,
          delay: 100,
        }
      } else {
        // If all keys are quarantined, check if the earliest quarantine expires soon
        const earliest = pool.getEarliestQuarantineExpiry(providerID)
        const now = Date.now()
        if (earliest && earliest > now && earliest - now <= 10_000) {
          const waitMs = Math.max(200, earliest - now)
          event.decision = {
            retry: true,
            delay: waitMs + 200,
          }
          return
        }

        event.decision = { retry: false }
        const totalKeys = pool.status(providerID).length
        if (event.error) {
          event.error.type = "failover.exhausted"
          event.error.message = `[opencode-failover] All ${totalKeys} keys for provider "${providerID}" were attempted and are exhausted/quarantined.`
        }
        safeToast(input, `Cannot retry — all keys exhausted for ${providerID}.`, "error")
      }
    } catch {}
  })
}
