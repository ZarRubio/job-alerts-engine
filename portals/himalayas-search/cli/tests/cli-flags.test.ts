import { describe, expect, test } from "bun:test"
import { runCLI } from "./helpers"

// Every case here fails validation before any request is made, so the suite
// stays network-free.

function errorOf(stderr: string): { error: string; code: string } {
  return JSON.parse(stderr.split("\n")[0])
}

describe("cli flag validation", () => {
  test("an unknown flag exits 1 with a JSON error", async () => {
    const r = await runCLI(["search", "-q", "react", "--bogus", "1"])
    expect(r.exitCode).toBe(1)
    expect(errorOf(r.stderr).code).toBe("UNKNOWN_FLAG")
    expect(r.stdout).toBe("")
  })

  test("contradictory worldwide flags are refused", async () => {
    const r = await runCLI(["search", "--worldwide", "--exclude-worldwide", "--country", "PE"])
    expect(r.exitCode).toBe(1)
    expect(errorOf(r.stderr).code).toBe("BAD_ARG")
  })

  test("an unknown seniority is refused", async () => {
    const r = await runCLI(["search", "--seniority", "Junior"])
    expect(r.exitCode).toBe(1)
    expect(errorOf(r.stderr).code).toBe("BAD_ARG")
  })

  test("non-integer --jobage and bad --format are refused", async () => {
    expect((await runCLI(["search", "--jobage", "0.5"])).exitCode).toBe(1)
    expect((await runCLI(["search", "--format", "xml"])).exitCode).toBe(1)
  })

  test("detail without an id exits 1", async () => {
    const r = await runCLI(["detail"])
    expect(r.exitCode).toBe(1)
    expect(errorOf(r.stderr).code).toBe("NO_ID")
  })

  test("an unknown command exits 1", async () => {
    const r = await runCLI(["frobnicate"])
    expect(r.exitCode).toBe(1)
    expect(errorOf(r.stderr).code).toBe("BAD_CMD")
  })

  test("--help prints usage", async () => {
    const r = await runCLI(["search", "--help"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("himalayas-cli")
  })
})
