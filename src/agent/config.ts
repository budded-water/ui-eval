import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { Type, type Static } from "@sinclair/typebox"
import Ajv2020 from "ajv/dist/2020.js"

const identifier = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
})
const projectPath = Type.String({
  minLength: 1,
  pattern: "^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!/).+$",
})

export const AgentSuiteSchema = Type.Object(
  {
    apiVersion: Type.Literal("uieval.io/v1alpha1"),
    kind: Type.Literal("AgentSuite"),
    id: identifier,
    revision: Type.Integer({ minimum: 1 }),
    maxIterations: Type.Integer({ minimum: 1, maximum: 10 }),
    plateau: Type.Object(
      {
        maxConsecutiveNoImprovement: Type.Integer({ minimum: 1, maximum: 5 }),
        minScoreImprovement: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    requiredDimensions: Type.Array(identifier, {
      minItems: 1,
      uniqueItems: true,
    }),
    mutation: Type.Object(
      {
        allowedPathPrefixes: Type.Array(projectPath, {
          minItems: 1,
          uniqueItems: true,
        }),
        protectedPathPrefixes: Type.Array(projectPath, {
          minItems: 1,
          uniqueItems: true,
        }),
        maxChangedFiles: Type.Integer({ minimum: 1, maximum: 100 }),
      },
      { additionalProperties: false },
    ),
    scenarios: Type.Array(
      Type.Object(
        {
          id: identifier,
          policy: Type.Optional(projectPath),
          reference: Type.Optional(projectPath),
          maxChangedPixelRatio: Type.Optional(
            Type.Number({ minimum: 0, maximum: 1 }),
          ),
          dimensions: Type.Array(identifier, {
            minItems: 1,
            uniqueItems: true,
          }),
          timeoutMs: Type.Integer({ minimum: 1_000, maximum: 600_000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    checks: Type.Array(
      Type.Object(
        {
          id: identifier,
          command: Type.String({ minLength: 1 }),
          args: Type.Array(Type.String()),
          timeoutMs: Type.Integer({ minimum: 1, maximum: 1_800_000 }),
          dimension: identifier,
          onFailure: Type.Optional(
            Type.Union([Type.Literal("repair"), Type.Literal("block")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    repair: Type.Optional(
      Type.Object(
        {
          command: Type.String({ minLength: 1 }),
          args: Type.Array(Type.String()),
          timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export type AgentSuite = Static<typeof AgentSuiteSchema>

const validate = new Ajv2020({ allErrors: true }).compile(AgentSuiteSchema)

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export async function loadAgentSuite(
  projectRootInput: string,
  suite: string,
): Promise<{ projectRoot: string; path: string; value: AgentSuite }> {
  const projectRoot = await realpath(projectRootInput)
  const reference = suite.includes("/") || suite.endsWith(".json")
    ? suite
    : `ui-eval/agents/${suite}.json`
  const path = resolve(projectRoot, reference)
  if (!contained(projectRoot, path)) {
    throw new Error(`Agent suite escapes the project root: ${reference}`)
  }
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
      .join("; ")
    throw new Error(`Invalid agent suite ${path}: ${details}`)
  }
  return { projectRoot, path, value: value as AgentSuite }
}
