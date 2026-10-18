import { describe, it, expect } from "bun:test"
import plugin from "./index.ts"

describe("OpenCode v2 tool wrapper", () => {
  it("wraps tools and guarantees { content } return object without 'output' property", async () => {
    let registeredTools: any[] = []
    const fakeInput = {
      directory: process.cwd(),
      tool: {
        transform: (cb: (registry: { add: (t: any) => void }) => void) => {
          cb({
            add: (t: any) => registeredTools.push(t),
          })
        },
      },
    }

    await plugin.setup(fakeInput)

    const statusTool = registeredTools.find((t) => t.id === "keychain-status")
    expect(statusTool).toBeDefined()
    expect(statusTool.name).toBe("keychain-status")

    // Execute the status tool
    const result = await statusTool.execute({})

    // Critical invariants for OpenCode v2 runtime:
    // 1. Result MUST be an object (so "output" in result doesn't throw TypeError)
    expect(typeof result).toBe("object")
    expect(result).not.toBeNull()

    // 2. Result MUST NOT have "output" property when no output schema was declared
    expect("output" in result).toBe(false)

    // 3. Result MUST have "content" property of type string
    expect("content" in result).toBe(true)
    expect(typeof result.content).toBe("string")
    expect(result.content).toContain("opencode-failover")
  })

  it("handles tool errors without throwing unhandled exceptions", async () => {
    let registeredTools: any[] = []
    const fakeInput = {
      directory: process.cwd(),
      tool: {
        transform: (cb: (registry: { add: (t: any) => void }) => void) => {
          cb({
            add: (t: any) => registeredTools.push(t),
          })
        },
      },
    }

    await plugin.setup(fakeInput)

    const setupTool = registeredTools.find((t) => t.id === "keychain-setup")
    expect(setupTool).toBeDefined()

    // Pass invalid args (missing provider/keys)
    const result = await setupTool.execute({})
    expect(typeof result).toBe("object")
    expect("output" in result).toBe(false)
    expect(typeof result.content).toBe("string")
  })
})
