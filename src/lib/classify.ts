export enum ErrorAction {
  Rotate = "rotate",
  Disable = "disable",
  Ignore = "ignore",
  Overload = "overload",
}

export interface ClassifierResult {
  action: ErrorAction
  retryAfterMs: number | null
  reason: string
}

interface APIError {
  statusCode?: number
  responseHeaders?: Record<string, string | null>
  responseBody?: string
  message?: string
  isRetryable?: boolean
}

export function classify(raw: unknown): ClassifierResult {
  const error = (raw as Record<string, unknown>).data ?? raw
  const status = Number((error as APIError).statusCode ?? (error as Record<string, unknown>).status ?? 0)
  const headers = (error as APIError).responseHeaders ?? (error as Record<string, unknown>).headers ?? {}
  const body = String((error as APIError).responseBody ?? (error as Record<string, unknown>).body ?? "")
  const message = String((error as APIError).message ?? (error as Record<string, unknown>).message ?? "")
  const isRetryable = Boolean((error as APIError).isRetryable ?? (error as Record<string, unknown>).isRetryable ?? false)

  const errorType = String((error as any).type ?? (error as any).name ?? (error as any)._tag ?? "")
  const fullMessage = [message, errorType].filter(Boolean).join(" ")

  let retryAfterMs = parseRetryAfter(headers as Record<string, string>)
  if (retryAfterMs === null) {
    retryAfterMs = parseBodyRetryAfter(fullMessage) ?? parseBodyRetryAfter(body)
  }

  if (hasOverloadPattern(body, fullMessage)) {
    return { action: ErrorAction.Overload, retryAfterMs: retryAfterMs ?? 2000, reason: `Server overload — pattern: ${detectOverloadPattern(body, fullMessage)}` }
  }

  if (status === 429) {
    return { action: ErrorAction.Rotate, retryAfterMs, reason: `Rate limited — HTTP 429` }
  }

  if (hasRateLimitPattern(body, fullMessage)) {
    return { action: ErrorAction.Rotate, retryAfterMs, reason: `Rate limit — pattern: ${detectPattern(body, fullMessage)}` }
  }

  if (status === 401 || status === 403 || status === 402) {
    if (
      body.toLowerCase().includes("workspace access denied") ||
      fullMessage.toLowerCase().includes("workspace access denied")
    ) {
      return { action: ErrorAction.Rotate, retryAfterMs: retryAfterMs ?? 60000, reason: "Workspace access mismatch" }
    }
    const label = status === 402 ? "Payment required" : status === 401 ? "Authentication failed" : "Forbidden"
    return { action: ErrorAction.Disable, retryAfterMs: null, reason: `${label} — HTTP ${status}` }
  }

  if (status >= 500 && status < 600) {
    return { action: ErrorAction.Rotate, retryAfterMs: null, reason: `Server error — HTTP ${status}` }
  }

  return { action: ErrorAction.Ignore, retryAfterMs: null, reason: "Non-retryable error" }
}

function parseRetryAfter(headers: Record<string, string>): number | null {
  const retryAfterMs = headers["retry-after-ms"]
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsed) && parsed > 0) return Math.ceil(parsed)
  }
  const retryAfter = headers["retry-after"]
  if (retryAfter) {
    const parsed = Number.parseFloat(retryAfter)
    if (!Number.isNaN(parsed) && parsed > 0) return Math.ceil(parsed * 1000)
    const dateParsed = Date.parse(retryAfter)
    if (!Number.isNaN(dateParsed)) {
      const ms = dateParsed - Date.now()
      if (ms > 0) return Math.ceil(ms)
    }
  }
  return null
}

function parseBodyRetryAfter(text: string): number | null {
  const match = text.match(/\bin\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?\b/i)
  if (!match) return null
  const h = parseInt(match[1] || "0", 10)
  const m = parseInt(match[2] || "0", 10)
  const s = parseInt(match[3] || "0", 10)
  if (h === 0 && m === 0 && s === 0) return null
  return (h * 3600 + m * 60 + s) * 1000
}

function hasOverloadPattern(body: string, message: string): boolean {
  return detectOverloadPattern(body, message) !== null
}

function detectOverloadPattern(body: string, message: string): string | null {
  const lower = body.toLowerCase() + " " + message.toLowerCase()
  const patterns = [
    "resourcexhausted",
    "resource exhausted",
    "resource_exhausted",
    "res_exhausted",
    "res exhausted",
    "exhausted",
    "worker local total request limit",
    "server is overloaded",
    "overloaded",
    "service unavailable",
    "capacity",
    "quota",
  ]
  for (const p of patterns) {
    if (lower.includes(p)) return `"${p}"`
  }
  return null
}

function hasRateLimitPattern(body: string, message: string): boolean {
  return detectPattern(body, message) !== null
}

function detectPattern(body: string, message: string): string | null {
  const lower = body.toLowerCase() + " " + message.toLowerCase()
  const patterns = [
    "rate increased too quickly",
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "too_many_requests",
    "freeusagelimiterror",
    "free usage limit",
    "free_usage_limit",
    "usage limit",
    "quota exceeded",
    "quotaexceeded",
    "freetier",
    "free_tier",
    "credit balance",
    "insufficient quota",
    "unavailable",
  ]
  for (const p of patterns) {
    if (lower.includes(p)) return `"${p}"`
  }

  try {
    const json = JSON.parse(body)
    const errType = String(json?.error?.type ?? json?.type ?? "")
    if (errType.toLowerCase().includes("freeusagelimit") || errType.toLowerCase().includes("quota") || errType.toLowerCase().includes("rate")) {
      return `"${errType}" (json.error.type)`
    }
    if (json?.type === "error" && json?.error?.type === "too_many_requests") return `"too_many_requests" (json.type)`
    const code = typeof json?.code === "string" ? json.code : ""
    if (code.includes("unavailable")) return `"${code}" (json.code)`
    if (json?.type === "error" && typeof json?.error?.code === "string" && json.error.code.includes("rate_limit")) return `"${json.error.code}" (json.error.code)`
  } catch {
  }

  return null
}