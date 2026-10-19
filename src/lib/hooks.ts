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

import { getOriginalFetch } from "./fetch-patch.ts"

export const opencodeOrgCache = new Map<string, string>([
  ["oc_sk_c94f11e9e416_7XlwOi6IqVsl6zQKieIv8JZqjf02RLb0", "org_01M55RY35H1AWP84GFGA04WAX2"],
  ["oc_sk_7e1338de5f7a_C9690qgFz5FRBfaY5rOqSQqzkoulXae-", "wrk_01KTA98KJ3F66H7JCDYNS2E824"],
  ["oc_sk_6c706ed80bf8_HwQSC-uExVhzjyzofwNbrh5YYwIar3rD", "org_01M55S80X4Z5SZBPRKAA1HDSRB"],
  ["oc_sk_84f188e094b0_Pb0Fd03crbcY-SXDN24I1KcLYGjzWm3A", "org_01M58AXZG0FY0P2BP3WT37D1B2"],
  ["oc_sk_e4f8d8517689_3yBp7QbNwdppDCa8ayDJnrGfM0NWxDqq", "org_01M58AZD6ZJWH7W3WHMDD7ND38"],
])

export async function getOpencodeOrgId(key: string): Promise<string | null> {
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

async function applyAuthToHeaders(headers: Headers, providerID: string, key: string): Promise<string | null> {
  const norm = providerID.toLowerCase()
  if (norm === "anthropic") {
    headers.set("x-api-key", key)
    return null
  } else if (norm === "google" || norm.includes("gemini")) {
    headers.set("x-goog-api-key", key)
    return null
  } else {
    headers.set("authorization", `Bearer ${key}`)
    if (norm === "opencode") {
      const orgId = await getOpencodeOrgId(key)
      if (orgId) {
        headers.set("x-opencode-org-id", orgId)
        headers.set("x-org-id", orgId)
      }
      return orgId
    }
    return null
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

      let orgId: string | null = null
      if (event.request?.headers && typeof event.request.headers.set === "function") {
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
