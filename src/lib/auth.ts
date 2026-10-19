import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

type AuthEntry = {
  type: string
  key: string
  metadata?: Record<string, string>
  accountId?: string
  token?: string
  refresh?: string
  access?: string
  expires?: number
  enterpriseUrl?: string
}

function authFilePath(): string {
  if (Bun.env.OPENCODE_CONFIG_DIR) {
    return path.join(Bun.env.OPENCODE_CONFIG_DIR, "auth.json")
  }
  const xdgData = Bun.env.XDG_DATA_HOME ?? process.env.XDG_DATA_HOME
  if (xdgData) {
    return path.join(xdgData, "opencode", "auth.json")
  }
  const base = Bun.env.HOME ?? Bun.env.USERPROFILE ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  return path.join(base, ".local", "share", "opencode", "auth.json")
}

export function opencodeDbPath(): string {
  if (Bun.env.OPENCODE_CONFIG_DIR) {
    return path.join(Bun.env.OPENCODE_CONFIG_DIR, "opencode.db")
  }
  const xdgData = Bun.env.XDG_DATA_HOME ?? process.env.XDG_DATA_HOME
  if (xdgData) {
    return path.join(xdgData, "opencode", "opencode.db")
  }
  const base = Bun.env.HOME ?? Bun.env.USERPROFILE ?? process.env.HOME ?? process.env.USERPROFILE ?? ""
  return path.join(base, ".local", "share", "opencode", "opencode.db")
}

export function syncCredentialDb(providerID: string, key: string): void {
  try {
    const dbPath = opencodeDbPath()
    if (!existsSync(dbPath)) return
    const { Database } = require("bun:sqlite")
    const db = new Database(dbPath)
    try {
      const now = Date.now()
      const jsonValue = JSON.stringify({ type: "key", key })

      const rows = db
        .query("SELECT id, value, active FROM credential WHERE integration_id = ?")
        .all(providerID) as Array<{ id: string; value: string; active: number | null }>

      if (rows && rows.length > 0) {
        const matching = rows.find(r => {
          try {
            return JSON.parse(r.value).key === key
          } catch {
            return false
          }
        })
        if (matching) {
          db.query("UPDATE credential SET active = 0 WHERE integration_id = ?").run(providerID)
          db.query("UPDATE credential SET active = 1, time_updated = ? WHERE id = ?").run(now, matching.id)
        } else {
          const activeRow = rows.find(r => r.active === 1) ?? rows[0]
          if (activeRow) {
            db.query("UPDATE credential SET value = ?, time_updated = ? WHERE id = ?").run(jsonValue, now, activeRow.id)
          }
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // Gracefully ignore if SQLite is not available or locked
  }
}

export function readAuth(): Record<string, AuthEntry> {
  const p = authFilePath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return {}
  }
}

export function writeAuthKey(providerID: string, key: string, metadata?: Record<string, string>): void {
  const p = authFilePath()
  const dir = path.dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const all = readAuth()
  const existing = all[providerID]
  const norm = providerID.toLowerCase()
  let finalMeta = metadata
  if (!finalMeta && existing?.metadata) {
    if (norm !== "opencode" || existing.key === key) {
      finalMeta = existing.metadata
    }
  }
  all[providerID] = {
    type: existing?.type ?? "api",
    key,
    ...(finalMeta ? { metadata: finalMeta } : {}),
    ...(existing?.accountId ? { accountId: existing.accountId } : {}),
    ...(existing?.token ? { token: existing.token } : {}),
    ...(existing?.refresh ? { refresh: existing.refresh } : {}),
    ...(existing?.access ? { access: existing.access } : {}),
    ...(existing?.expires ? { expires: existing.expires } : {}),
    ...(existing?.enterpriseUrl ? { enterpriseUrl: existing.enterpriseUrl } : {}),
  }
  writeFileSync(p, JSON.stringify(all, null, 2), { encoding: "utf-8" })
  syncCredentialDb(providerID, key)
}

export function removeAuthKey(providerID: string): void {
  const all = readAuth()
  if (!all[providerID]) return
  delete all[providerID]
  const p = authFilePath()
  writeFileSync(p, JSON.stringify(all, null, 2), { encoding: "utf-8" })
}
