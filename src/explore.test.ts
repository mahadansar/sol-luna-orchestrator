/**
 * P2.1 Optional Explorer deterministic test suite.
 *
 * Verifies that the exploration companion is optional, bounded, strictly
 * read-only, distinguishes observed facts from inferences/unknowns, integrates
 * with compute policy and context lifecycle, and prevents recursive delegation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  exploreInputSchema,
  exploreMcpInputShape,
  explorerOutputJsonSchema,
  INPUT_METADATA_SIZE_BUDGETS,
  inputMetadataSizeReport,
  type ExploreInput,
  type ExploreOutput,
  type ExploreReport,
} from "./contract.js";
import { buildExplorerPrompt } from "./prompt.js";
import {
  buildExploreResult,
  exploreWithLuna,
  validateExploreFindings,
  parseExploreReport,
  type ObservedRun,
  type WorkerCodex,
} from "./worker.js";
import {
  handleExplore,
  isCleanExplore,
  renderExploreResult,
  registerExplore,
  EXPLORE_TOOL_DESCRIPTION,
  ContextLifecycleRegistry,
} from "./server.js";
import {
  compactContext,
  createOrchestrationContext,
  ingestExplorationTurn,
  isCleanExploreResult,
  ContextLifecycleStore,
} from "./context.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrchestratorEvent } from "./events.js";
import {
  collectExplorationMutations,
  createExplorationSurface,
  removeExplorationSurface,
  verifyGrounding,
  type ExplorationSurface,
} from "./explorer-surface.js";
import { parseEventLine } from "./cli/activity-reducer.js";

// --- 1. Contract & Schema Validation ----------------------------------------

test("explore input schema accepts valid contract and applies defaults", () => {
  const parsed = exploreInputSchema.parse({
    target: "Investigate database connection pooling and failover mechanics",
    effortReason: "Need to understand pooling configuration before migration",
    scope: ["**"],
  });

  assert.equal(
    parsed.target,
    "Investigate database connection pooling and failover mechanics",
  );
  assert.equal(parsed.effort, "high");
  assert.deepEqual(parsed.scope, ["**"]);
  assert.deepEqual(parsed.forbiddenFiles, []);
  assert.deepEqual(parsed.questions, []);
  assert.equal(parsed.resultDetail, "handoff");
});

test("explore input schema rejects target shorter than 10 characters", () => {
  assert.throws(
    () =>
      exploreInputSchema.parse({
        target: "Too short",
        effortReason: "Need to understand pooling configuration",
        scope: ["**"],
      }),
    (err: Error) => {
      assert.match(
        err.message,
        /target must describe what to explore in at least 10 characters/,
      );
      return true;
    },
  );
});

test("explore input schema rejects missing effortReason", () => {
  assert.throws(
    () =>
      exploreInputSchema.parse({
        target: "Investigate database connection pooling and failover mechanics",
        scope: ["**"],
      }),
    /Required|effortReason/,
  );
});

test("explore input schema accepts structured contextCapsule and questions", () => {
  const parsed = exploreInputSchema.parse({
    target: "Inspect JWT signing algorithms in auth module",
    effort: "medium",
    effortReason: "Clarify supported algorithms for token validation",
    questions: [
      "Which algorithms are supported in verifyToken?",
      "Where is the secret key loaded?",
    ],
    contextCapsule: {
      relevantContext: "Migrating from HMAC to RSA tokens.",
      interfaces: "AuthService.verify(token: string): Promise<Payload>",
    },
    scope: ["src/auth/**"],
    forbiddenFiles: ["src/billing/**"],
  });

  assert.equal(parsed.effort, "medium");
  assert.equal(parsed.questions.length, 2);
  assert.equal(
    parsed.contextCapsule?.relevantContext,
    "Migrating from HMAC to RSA tokens.",
  );
  assert.deepEqual(parsed.scope, ["src/auth/**"]);
  assert.deepEqual(parsed.forbiddenFiles, ["src/billing/**"]);
});

// --- 2. Prompt Construction -------------------------------------------------

test("buildExplorerPrompt enforces strictly read-only intent and forbids delegation", () => {
  const input: ExploreInput = {
    target: "Investigate event emitter memory leak in background workers",
    effort: "high",
    effortReason: "Trace event listeners attached without removeListener calls",
    scope: ["src/events/**", "src/workers/**"],
    forbiddenFiles: ["config/secrets.json"],
    questions: ["Are listeners unregistered on worker shutdown?"],
    context: "Memory profiling indicates listeners accumulate over time.",
    contextCapsule: {
      invariants: "Worker threads must release all event listeners on terminate.",
    },
    resultDetail: "handoff",
  };

  const prompt = buildExplorerPrompt(input, "/app/workspace");

  assert.match(prompt, /You are Luna, an isolated read-only exploration assistant/);
  assert.match(prompt, /Working directory: \/app\/workspace/);
  assert.match(prompt, /## Exploration target\n\nInvestigate event emitter memory leak/);
  assert.match(prompt, /Selected intent: \*\*forbidden\*\*/);
  assert.match(
    prompt,
    /This exploration is strictly read-only: do NOT create, modify, or delete files/,
  );
  assert.match(prompt, /You cannot delegate\s+further/);
  assert.match(prompt, /Are listeners unregistered on worker shutdown\?/);
  assert.match(prompt, /Memory profiling indicates listeners accumulate/);
  assert.match(prompt, /Worker threads must release all event listeners on terminate/);
  assert.match(
    prompt,
    /Focus your investigation primarily on files matching:\n- src\/events\/\*\*\n- src\/workers\/\*\*/,
  );
  assert.match(
    prompt,
    /You must NOT inspect or touch files matching:\n- config\/secrets\.json/,
  );
  assert.match(
    prompt,
    /Your final message must be a single JSON object matching the required schema/,
  );
});

// --- 3. Output Schema & Report Parsing ---------------------------------------

test("parseExploreReport accepts only one complete schema-valid JSON payload", () => {
  const sampleReport: ExploreReport = {
    status: "PASS",
    summary: "Discovered authentication mechanism and session storage.",
    observedFacts: [
      {
        statement:
          "Auth token is validated via jsonwebtoken.verify in middleware/auth.ts",
        sourceFile: "src/middleware/auth.ts",
        sourceLine: 12,
        evidence: "jwt.verify(token, process.env.JWT_SECRET)",
      },
    ],
    inferences: [
      {
        hypothesis: "Session expiration defaults to 1 hour if not specified.",
        rationale: "Default constant DEFAULT_EXPIRY = 3600 in src/config.ts",
      },
    ],
    unknowns: [
      {
        question: "Is refresh token rotation enabled in production?",
        whyUnresolved:
          "Production configuration is loaded from remote SSM parameter store.",
      },
    ],
    relevantFiles: [
      { path: "src/middleware/auth.ts", why: "Token verification entry point" },
    ],
    recommendedSeams: [
      {
        label: "Token verification upgrade",
        description: "Decouple algorithm selection from token parser",
        candidateFiles: ["src/middleware/auth.ts", "src/auth/verifier.ts"],
      },
    ],
    notes: "No breaking changes needed for token parser refactor.",
  };

  // Bare JSON
  const parsed1 = parseExploreReport(JSON.stringify(sampleReport));
  assert.deepEqual(parsed1, sampleReport);

  // Commentary and fences are rejected even when they contain a valid object.
  const parsed2 = parseExploreReport(
    `Here are my findings:\n\`\`\`json\n${JSON.stringify(sampleReport)}\n\`\`\``,
  );
  assert.equal(parsed2, null);

  // Embedded JSON in prose
  const parsed3 = parseExploreReport(
    `Prefix commentary...\n${JSON.stringify(sampleReport)}\nSuffix commentary...`,
  );
  assert.equal(parsed3, null);

  assert.equal(
    parseExploreReport(
      `${JSON.stringify(sampleReport)}\n${JSON.stringify(sampleReport)}`,
    ),
    null,
  );
  assert.equal(
    parseExploreReport(JSON.stringify({ ...sampleReport, unexpected: true })),
    null,
  );
});

test("parseExploreReport returns null on unparseable or invalid status reports", () => {
  assert.equal(parseExploreReport(""), null);
  assert.equal(parseExploreReport("Not JSON at all"), null);
  assert.equal(parseExploreReport(JSON.stringify({ status: "INVALID_STATUS" })), null);
});

// --- 4. Result Assembly & Read-Only Invariants ------------------------------

test("buildExploreResult does not upgrade unvalidated worker claims to clean facts", () => {
  const input = exploreInputSchema.parse({
    target: "Investigate logger implementation",
    effort: "high",
    effortReason: "Determine if pino or winston is used",
    scope: ["src/**"],
    resultDetail: "handoff",
  });

  const observed: ObservedRun = {
    threadId: "thread-exp-1",
    finalResponse: JSON.stringify({
      status: "PASS",
      summary: "Pino is used for all structured application logging.",
      observedFacts: [
        {
          statement: "Pino instance created in src/log.ts",
          sourceFile: "src/log.ts",
          sourceLine: 1,
          evidence: "pino({ level: process.env.LOG_LEVEL ?? 'info' })",
        },
      ],
      inferences: [],
      unknowns: [],
      relevantFiles: [{ path: "src/log.ts", why: "Logger factory" }],
      recommendedSeams: [],
      notes: "",
    }),
    filesChanged: [],
    errors: [],
    usage: {
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 200,
      reasoningOutputTokens: 50,
    },
    timedOut: false,
    cancelled: false,
    termination: "completed",
    terminationMessage: null,
  };

  const result = buildExploreResult({
    input,
    workingDirectory: process.cwd(),
    observed,
    durationSeconds: 3,
  });

  assert.equal(result.verdict, "FAILED");
  assert.equal(result.workerClaimedStatus, "PASS");
  assert.equal(result.trustworthy, false);
  assert.equal(result.observedFilesChanged.length, 0);
  assert.ok(result.discrepancies.some((item) => /not checked against/i.test(item)));
  assert.equal(result.scopeViolations.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.findings.observedFacts.length, 1);
  assert.equal(result.findings.observedFacts[0]?.provenance, "worker");
  assert.equal(result.findings.observedFacts[0]?.grounding, "unverified");
  assert.equal(isCleanExplore(result), false);
});

test("buildExploreResult fails verdict and marks untrustworthy when runtime observes file edits", () => {
  const input = exploreInputSchema.parse({
    target: "Investigate logger implementation",
    effort: "high",
    effortReason: "Determine if pino or winston is used",
    scope: ["src/**"],
    resultDetail: "handoff",
  });

  const observed: ObservedRun = {
    threadId: "thread-exp-edit",
    finalResponse: JSON.stringify({
      status: "PASS",
      summary: "I investigated the logger and edited src/log.ts to test formatting.",
      observedFacts: [],
      inferences: [],
      unknowns: [],
      relevantFiles: [],
      recommendedSeams: [],
      notes: "",
    }),
    filesChanged: [{ path: "src/log.ts", kind: "modified" }],
    errors: [],
    usage: null,
    timedOut: false,
    cancelled: false,
    termination: "completed",
    terminationMessage: null,
  };

  const result = buildExploreResult({
    input,
    workingDirectory: process.cwd(),
    observed,
    durationSeconds: 2,
  });

  assert.equal(result.verdict, "FAILED");
  assert.equal(result.trustworthy, false);
  assert.equal(result.observedFilesChanged.length, 1);
  assert.ok(result.discrepancies.some((d) => /Change intent contract violated/i.test(d)));
  assert.equal(isCleanExplore(result), false);
});

test("buildExploreResult handles unparseable worker message with failure and error report", () => {
  const input = exploreInputSchema.parse({
    target: "Investigate caching layer",
    effort: "high",
    effortReason: "Examine Redis cache ttl",
    scope: ["src/**"],
    resultDetail: "handoff",
  });

  const observed: ObservedRun = {
    threadId: "thread-exp-err",
    finalResponse: "I found some files but didn't return JSON.",
    filesChanged: [],
    errors: [],
    usage: null,
    timedOut: false,
    cancelled: false,
    termination: "completed",
    terminationMessage: null,
  };

  const result = buildExploreResult({
    input,
    workingDirectory: process.cwd(),
    observed,
    durationSeconds: 1,
  });

  assert.equal(result.verdict, "FAILED");
  assert.equal(result.trustworthy, false);
  assert.ok(
    result.errors.some((e) =>
      /not valid JSON matching the explorer output schema/i.test(e),
    ),
  );
});

test("buildExploreResult fails closed when the SDK stream contains multiple payload messages", () => {
  const input = exploreInputSchema.parse({
    target: "Inspect the caching implementation for deterministic behavior",
    effortReason: "Conflicting structured payloads must never be selected heuristically",
    scope: ["src/**"],
  });
  const observed: ObservedRun = {
    threadId: "thread-multiple-payloads",
    finalResponse: JSON.stringify({
      status: "PASS",
      summary: "Second payload",
      observedFacts: [],
      inferences: [],
      unknowns: [],
      relevantFiles: [],
      recommendedSeams: [],
      notes: "",
    }),
    agentMessageCount: 2,
    filesChanged: [],
    errors: [],
    usage: null,
    timedOut: false,
    cancelled: false,
    termination: "completed",
    terminationMessage: null,
  };
  const result = buildExploreResult({
    input,
    workingDirectory: process.cwd(),
    observed,
    durationSeconds: 1,
  });
  assert.equal(result.verdict, "FAILED");
  assert.equal(result.trustworthy, false);
  assert.ok(
    result.errors.some((error) => /multiple final-message payloads/i.test(error)),
  );
});

test("exploreWithLuna grounds claims in a disposable scoped surface with selected compute", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-explore-source-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "log.ts"),
      "const other = true;\nexport const logger = pino({ level: 'info' });\n",
      "utf8",
    );

    let threadOptions: any;
    let turnOptions: any;
    const report: ExploreReport = {
      status: "PASS",
      summary: "The logger uses pino.",
      observedFacts: [
        {
          statement: "The logger is constructed with pino.",
          sourceFile: "src/log.ts",
          sourceLine: 2,
          evidence: "export const logger = pino({ level: 'info' });",
        },
      ],
      inferences: [],
      unknowns: [],
      relevantFiles: [{ path: "src/log.ts", why: "Logger construction" }],
      recommendedSeams: [],
      notes: "",
    };
    const codex: WorkerCodex = {
      startThread(options) {
        threadOptions = options;
        return {
          id: "thread-grounding",
          async runStreamed(_input, options) {
            turnOptions = options;
            async function* events(): AsyncGenerator<any> {
              yield { type: "thread.started", thread_id: "thread-grounding" };
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: JSON.stringify(report) },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 10,
                  cached_input_tokens: 0,
                  output_tokens: 5,
                  reasoning_output_tokens: 1,
                },
              };
            }
            return { events: events() };
          },
        };
      },
      resumeThread() {
        throw new Error("not used");
      },
    };

    const result = await exploreWithLuna(
      exploreInputSchema.parse({
        target: "Inspect the logger construction and report its implementation",
        effort: "xhigh",
        effortReason: "The test must verify compute propagation and source grounding",
        scope: ["src/**"],
        workingDirectory: root,
      }),
      undefined,
      {},
      "gpt-5.6-luna",
      { codex },
    );

    assert.equal(result.verdict, "PASS");
    assert.equal(result.trustworthy, true);
    assert.equal(result.findings.observedFacts[0]?.provenance, "worker");
    assert.equal(result.findings.observedFacts[0]?.grounding, "runtime-verified");
    assert.equal(result.findings.runtimeObservedFacts[0]?.kind, "source-grounding");
    assert.equal(threadOptions.model, "gpt-5.6-luna");
    assert.equal(threadOptions.modelReasoningEffort, "xhigh");
    assert.equal(threadOptions.sandboxMode, "read-only");
    assert.notEqual(path.resolve(threadOptions.workingDirectory), path.resolve(root));
    assert.equal(turnOptions.outputSchema, explorerOutputJsonSchema);
    await assert.rejects(fs.stat(threadOptions.workingDirectory));
    assert.match(await fs.readFile(path.join(root, "src", "log.ts"), "utf8"), /pino/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exploreWithLuna detects disposable mutations without changing authoritative files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-explore-source-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "base.ts"), "export const base = 1;\n");

    let surfacePath = "";
    const codex: WorkerCodex = {
      startThread(options) {
        surfacePath = options.workingDirectory ?? "";
        return {
          id: "thread-mutation",
          async runStreamed() {
            await fs.writeFile(path.join(surfacePath, "src", "created.ts"), "mutated\n");
            async function* events(): AsyncGenerator<any> {
              yield { type: "thread.started", thread_id: "thread-mutation" };
              yield {
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: JSON.stringify({
                    status: "PASS",
                    summary: "Attempted a write.",
                    observedFacts: [],
                    inferences: [],
                    unknowns: [],
                    relevantFiles: [],
                    recommendedSeams: [],
                    notes: "",
                  }),
                },
              };
            }
            return { events: events() };
          },
        };
      },
      resumeThread() {
        throw new Error("not used");
      },
    };

    const result = await exploreWithLuna(
      exploreInputSchema.parse({
        target: "Inspect the base module without making any repository changes",
        effortReason: "Mutation isolation requires deterministic verification",
        scope: ["src/**"],
        workingDirectory: root,
      }),
      undefined,
      {},
      "gpt-5.6-luna",
      { codex },
    );

    assert.equal(result.verdict, "FAILED");
    assert.equal(result.trustworthy, false);
    assert.ok(
      result.observedFilesChanged.some(
        (change) => change.path === "src/created.ts" && change.kind === "created",
      ),
    );
    await assert.rejects(fs.stat(path.join(root, "src", "created.ts")));
    await assert.rejects(fs.stat(surfacePath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disposable manifest detects create, delete, modify, rename, and symlink changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-explore-source-"));
  let surface: Awaited<ReturnType<typeof createExplorationSurface>> | null = null;
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "modify.ts"), "before\n");
    await fs.writeFile(path.join(root, "src", "delete.ts"), "delete\n");
    await fs.writeFile(path.join(root, "src", "rename.ts"), "rename\n");
    await fs.writeFile(path.join(root, "src", "link-target.ts"), "target\n");
    surface = await createExplorationSurface(root, ["src/**"], []);

    await fs.writeFile(path.join(surface.path, "src", "modify.ts"), "after\n");
    await fs.rm(path.join(surface.path, "src", "delete.ts"));
    await fs.rename(
      path.join(surface.path, "src", "rename.ts"),
      path.join(surface.path, "src", "renamed.ts"),
    );
    await fs.writeFile(path.join(surface.path, "src", "untracked.ts"), "new\n");
    let symlinkCreated = true;
    try {
      await fs.symlink("link-target.ts", path.join(surface.path, "src", "link.ts"));
    } catch {
      symlinkCreated = false;
    }

    const mutations = await collectExplorationMutations(surface);
    assert.ok(
      mutations.some((item) => item.kind === "modified" && item.path === "src/modify.ts"),
    );
    assert.ok(
      mutations.some((item) => item.kind === "deleted" && item.path === "src/delete.ts"),
    );
    assert.ok(
      mutations.some(
        (item) =>
          item.kind === "renamed" && /rename\.ts -> src\/renamed\.ts/.test(item.path),
      ),
    );
    assert.ok(
      mutations.some(
        (item) => item.kind === "created" && item.path === "src/untracked.ts",
      ),
    );
    if (symlinkCreated) {
      assert.ok(
        mutations.some((item) => item.kind === "created" && item.path === "src/link.ts"),
      );
    }
  } finally {
    if (surface) await removeExplorationSurface(surface).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- 5. Server Handler & Lifecycle Integration ------------------------------

test("handleExplore executes exploration, records turn, and emits lifecycle events", async () => {
  const events: OrchestratorEvent[] = [];
  const lifecycleStore = new ContextLifecycleStore({ emit: (e) => events.push(e) });

  const input = exploreInputSchema.parse({
    target: "Explore payment gateway integration points",
    effort: "high",
    effortReason: "Map out Stripe webhook handlers",
    scope: ["src/routes/**", "src/middleware/**"],
    questions: ["Where are webhook signatures verified?"],
    resultDetail: "handoff",
  });

  const mockExploreWithLuna = async (
    inp: ExploreInput,
    _signal?: AbortSignal,
    hooks?: { onStarted?: (workingDirectory: string) => void },
  ): Promise<ExploreOutput> => {
    hooks?.onStarted?.("isolated-surface");
    return {
      target: inp.target,
      verdict: "PASS",
      workerClaimedStatus: "PASS",
      trustworthy: true,
      model: "gpt-5.6-luna",
      effort: inp.effort,
      effortReason: inp.effortReason,
      durationSeconds: 4,
      workerThreadId: "thread-stripe-exp",
      findings: {
        summary:
          "Stripe webhooks are handled in src/routes/stripe.ts with stripe.webhooks.constructEvent.",
        observedFacts: [
          {
            statement: "Webhook secret loaded from STRIPE_WEBHOOK_SECRET env variable",
            sourceFile: "src/routes/stripe.ts",
            sourceLine: 1,
            evidence: "const secret = process.env.STRIPE_WEBHOOK_SECRET;",
            provenance: "worker",
            grounding: "runtime-verified",
          },
        ],
        runtimeObservedFacts: [
          {
            kind: "source-grounding",
            statement:
              "The cited evidence text was present at the claimed source location.",
            sourceFile: "src/routes/stripe.ts",
            sourceLine: 1,
          },
        ],
        inferences: [
          {
            hypothesis:
              "Retry handling is handled by Stripe rather than local dead-letter queue",
            rationale: "No local queue or storage found in webhook route",
          },
        ],
        unknowns: [
          {
            question: "How are idempotency keys persisted across retries?",
            whyUnresolved: "Need to check database schema migrations",
          },
        ],
        relevantFiles: [
          { path: "src/routes/stripe.ts", why: "Stripe webhook route handler" },
        ],
        recommendedSeams: [
          {
            label: "Webhook verification middleware",
            description:
              "Extract signature verification into reusable express middleware",
            candidateFiles: ["src/routes/stripe.ts", "src/middleware/stripe-auth.ts"],
          },
        ],
        notes: "",
      },
      observedFilesChanged: [],
      scopeViolations: [],
      discrepancies: [],
      reviewChecklist: [
        "Review observed facts vs inferences before designing seams or implementation contracts.",
        "Address identified open unknowns before delegating implementation.",
      ],
      usage: {
        inputTokens: 2000,
        cachedInputTokens: 1000,
        outputTokens: 400,
        reasoningOutputTokens: 100,
      },
      errors: [],
    };
  };

  const response = await handleExplore(input, undefined, {
    exploreWithLuna: mockExploreWithLuna as any,
    emit: (e) => events.push(e),
    contextStore: lifecycleStore,
  });

  assert.equal(response.isError, false);
  assert.equal(response.content.length, 1);
  assert.match(response.content[0]?.text ?? "", /EXPLORATION VERDICT: PASS/);
  assert.match(response.content[0]?.text ?? "", /WORKER-GROUNDED CLAIMS \(1\):/);
  assert.match(response.content[0]?.text ?? "", /INFERENCES \(1\):/);
  assert.match(response.content[0]?.text ?? "", /UNKNOWNS \(1\):/);
  assert.match(response.content[0]?.text ?? "", /CANDIDATE SEAMS:/);

  // Verify events emitted
  const started = events.find((e) => e.type === "explore.started");
  const completed = events.find((e) => e.type === "explore.completed");
  assert.ok(started);
  assert.ok(completed);
  assert.equal(started.requestedModel, "gpt-5.6-luna");
  assert.equal(started.selectedModel, "gpt-5.6-luna");
  assert.equal(completed.executedModel, "gpt-5.6-luna");
  assert.equal(completed.workerGroundedClaimsCount, 1);
  assert.doesNotMatch(JSON.stringify(events), /payment gateway|Stripe webhook/i);

  // Verify turn recorded in ContextLifecycleStore
  const authContext = lifecycleStore.getAuthoritativeContext();
  assert.ok(authContext);
  assert.equal(authContext.turns.length, 1);
  assert.equal(authContext.turns[0]?.kind, "exploration");

  const compactResponse = await handleExplore(
    { ...input, resultDetail: "compact" },
    undefined,
    {
      exploreWithLuna: mockExploreWithLuna as any,
      emit: (e) => events.push(e),
      contextStore: new ContextLifecycleStore(),
    },
  );
  assert.ok(compactResponse.structuredContent);
  assert.equal("workerThreadId" in compactResponse.structuredContent, false);
  assert.equal("usage" in compactResponse.structuredContent, false);
});

test("handleExplore enforces compute policy narrowing and refuses disallowed configurations", async () => {
  const events: OrchestratorEvent[] = [];
  const lifecycleStore = new ContextLifecycleStore({ emit: (e) => events.push(e) });

  const input = exploreInputSchema.parse({
    target: "Investigate heavy background tasks",
    effort: "max",
    effortReason: "Need max compute reasoning",
    scope: ["src/**"],
    computePolicy: {
      allowedEfforts: ["medium", "high"], // excludes "max"
    },
  });

  const response = await handleExplore(input, undefined, {
    emit: (e) => events.push(e),
    contextStore: lifecycleStore,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0]?.text ?? "", /EXPLORATION REFUSED/);

  const rejected = events.find((e) => e.type === "explore.rejected");
  assert.ok(rejected);
  assert.equal(rejected.reasonCode, "compute-policy");

  const registry = new ContextLifecycleRegistry({ emit: (e) => events.push(e) });
  await handleExplore(input, undefined, {
    emit: (e) => events.push(e),
    contextRegistry: registry,
  });
  assert.equal((registry as any).stores.size, 0);
});

test("activity ingestion accepts redacted exploration lifecycle telemetry", () => {
  const parsed = parseEventLine(
    JSON.stringify({
      timestamp: "2026-08-28T00:00:00.000Z",
      type: "explore.started",
      batchId: "exp-safe",
      requestedModel: "gpt-5.6-luna",
      requestedEffort: "high",
      selectedModel: "gpt-5.6-luna",
      selectedEffort: "high",
    }),
  );
  assert.equal(parsed?.type, "explore.started");
  assert.equal("target" in (parsed ?? {}), false);
  assert.equal("workingDirectory" in (parsed ?? {}), false);
});

// --- 6. Rendering Details ---------------------------------------------------

test("renderExploreResult formats handoff, compact, and full details correctly", () => {
  const result: ExploreOutput = {
    target: "Investigate cache eviction policy",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    trustworthy: true,
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "Examine LRU cache behavior",
    durationSeconds: 2,
    workerThreadId: "thread-cache",
    findings: {
      summary: "LRU cache is configured with max 500 entries.",
      observedFacts: [
        {
          statement: "LRU capacity is 500 items",
          sourceFile: "src/cache.ts",
          sourceLine: 1,
          evidence: "new QuickLRU({ maxSize: 500 })",
          provenance: "worker",
          grounding: "runtime-verified",
        },
      ],
      runtimeObservedFacts: [],
      inferences: [],
      unknowns: [],
      relevantFiles: [{ path: "src/cache.ts", why: "LRU cache module" }],
      recommendedSeams: [],
      notes: "Memory overhead is under 5MB.",
    },
    observedFilesChanged: [],
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [
      "Review observed facts vs inferences before designing seams or implementation contracts.",
    ],
    usage: null,
    errors: [],
  };

  // handoff
  const handoff = renderExploreResult(result, "handoff");
  assert.match(handoff, /EXPLORATION VERDICT: PASS/);
  assert.match(handoff, /LRU capacity is 500 items/);
  assert.match(handoff, /NEXT: Treat worker-grounded claims and advisory seams/);

  // compact
  const compact = renderExploreResult(result, "compact");
  const compactParsed = JSON.parse(compact);
  assert.equal(compactParsed.verdict, "PASS");
  assert.equal(
    compactParsed.findings.summary,
    "LRU cache is configured with max 500 entries.",
  );
  assert.equal(compactParsed.workerThreadId, undefined);
  assert.equal(compactParsed.usage, undefined);

  // full
  const full = renderExploreResult(result, "full");
  const fullParsed = JSON.parse(full);
  assert.equal(fullParsed.target, "Investigate cache eviction policy");
  assert.equal(fullParsed.findings.observedFacts[0]?.sourceFile, "src/cache.ts");
});

// --- 7. Context Compaction for Exploration Turns ----------------------------

test("compactContext compacts exploration turns cleanly and preserves structured findings", () => {
  const context = createOrchestrationContext({
    objective: "Explore and refactor codebase",
    acceptanceCriteria: [],
  });

  const exploreResult: ExploreOutput = {
    target: "Investigate database query bottlenecks",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    trustworthy: true,
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "Profile slow queries in user repository",
    durationSeconds: 5,
    workerThreadId: "thread-db-profile",
    findings: {
      summary: "Found missing composite index on users(org_id, created_at).",
      observedFacts: [
        {
          statement:
            "Query in findByOrg filters on org_id and orders by created_at without composite index",
          sourceFile: "src/db/users.ts",
          sourceLine: 1,
          evidence: "WHERE org_id = $1 ORDER BY created_at DESC",
          provenance: "worker",
          grounding: "runtime-verified",
        },
      ],
      runtimeObservedFacts: [],
      inferences: [
        {
          hypothesis: "Adding index will reduce query time from 450ms to <10ms",
          rationale: "Explain analyze shows sequential scan on 200k rows",
        },
      ],
      unknowns: [
        {
          question: "Can migration run concurrently without locking table?",
          whyUnresolved: "Postgres version compatibility needs checking in infra repo",
        },
      ],
      relevantFiles: [{ path: "src/db/users.ts", why: "User queries" }],
      recommendedSeams: [
        {
          label: "Database index migration",
          description: "Add CREATE INDEX CONCURRENTLY migration script",
          candidateFiles: ["migrations/004_user_org_idx.sql"],
        },
      ],
      notes: "Low risk migration.",
    },
    observedFilesChanged: [],
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [
      "Address identified open unknowns before delegating implementation.",
    ],
    usage: null,
    errors: [],
  };

  const contextWithTurn = ingestExplorationTurn(context, {
    input: exploreInputSchema.parse({
      target: "Investigate database query bottlenecks",
      effort: "high",
      effortReason: "Profile slow queries in user repository",
      scope: ["src/db/**", "migrations/**"],
      resultDetail: "handoff",
    }),
    output: exploreResult,
  });

  assert.equal(contextWithTurn.turns.length, 1);
  assert.equal(contextWithTurn.turns[0]?.kind, "exploration");

  const compacted = compactContext(contextWithTurn);
  assert.equal(compacted.turns.length, 1);
  const compactedTurn = compacted.turns[0];
  assert.ok(compactedTurn);
  assert.equal(compactedTurn.kind, "exploration");
  assert.equal(compactedTurn.verdict, "PASS");
  assert.equal(compactedTurn.isClean, true);
  assert.ok(compactedTurn.explorationFindings);
  assert.equal(compactedTurn.explorationFindings.observedFacts.length, 1);
  assert.equal(compactedTurn.explorationFindings.inferences.length, 1);
  assert.equal(compactedTurn.explorationFindings.unknowns.length, 1);
  assert.equal(compactedTurn.explorationFindings.recommendedSeams.length, 1);
});

test("failed exploration compaction preserves trust and security evidence", () => {
  const context = createOrchestrationContext({
    objective: "Inspect a bounded module",
    acceptanceCriteria: [],
  });
  const output: ExploreOutput = {
    target: "Inspect the bounded authentication module",
    verdict: "FAILED",
    workerClaimedStatus: "PASS",
    trustworthy: false,
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "Security evidence must survive compaction",
    durationSeconds: 1,
    workerThreadId: "thread-failed-explore",
    findings: {
      summary: "A forbidden path was reported.",
      observedFacts: [],
      runtimeObservedFacts: [
        {
          kind: "surface-mutation",
          statement: "The disposable surface recorded a modified file.",
        },
      ],
      inferences: [],
      unknowns: [],
      relevantFiles: [],
      recommendedSeams: [],
      notes: "",
    },
    observedFilesChanged: [{ path: "secret.txt", kind: "modified" }],
    scopeViolations: ["secret.txt (matches forbiddenFiles)"],
    discrepancies: ["Change intent contract violated"],
    reviewChecklist: ["Do not trust the worker findings."],
    usage: null,
    errors: [],
  };
  const withTurn = ingestExplorationTurn(context, {
    input: exploreInputSchema.parse({
      target: "Inspect the bounded authentication module",
      effortReason: "Security evidence must survive compaction",
      scope: ["src/auth/**"],
      forbiddenFiles: ["secret.txt"],
    }),
    output,
  });
  assert.equal(withTurn.blockers[0]?.kind, "scope-violation");

  const compacted = compactContext(withTurn);
  assert.equal(compacted.turns[0]?.trustworthy, false);
  assert.deepEqual(compacted.turns[0]?.scopeViolations, output.scopeViolations);
  assert.deepEqual(compacted.turns[0]?.discrepancies, output.discrepancies);
  assert.equal(compacted.turns[0]?.explorationFindings?.runtimeObservedFacts.length, 1);
});

// --- 8. MCP Server Registration & Isolation ---------------------------------

test("registerExplore registers explore tool with proper schema and description", () => {
  const testServer = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { instructions: "test" },
  );

  registerExplore(testServer);

  // Verify explore tool registration
  const report = inputMetadataSizeReport();
  assert.ok(report.exploreTool > 0);
  assert.ok(report.exploreTool <= INPUT_METADATA_SIZE_BUDGETS.exploreTool);
});

// --- Audit regressions: exploration surface admission and grounding ---------

test("a nested repository's .git and .sol-luna never reach the exploration surface", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-explore-nested-"));
  let surface: Awaited<ReturnType<typeof createExplorationSurface>> | null = null;
  try {
    await fs.mkdir(path.join(root, "vendor", "dep", ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "vendor", "dep", ".sol-luna"), { recursive: true });
    // A vendored dependency, a submodule, or a fixture repo puts a second .git
    // below the root, and a git remote URL routinely carries a credential.
    await fs.writeFile(
      path.join(root, "vendor", "dep", ".git", "config"),
      "[remote]\n url = https://user:s3cr3t@example.invalid/x.git\n",
    );
    await fs.writeFile(
      path.join(root, "vendor", "dep", ".sol-luna", "state.json"),
      '{"kept":"runtime state"}\n',
    );
    await fs.writeFile(
      path.join(root, "vendor", "dep", "index.js"),
      "export const a=1;\n",
    );
    await fs.writeFile(path.join(root, "main.ts"), "export const b = 2;\n");

    surface = await createExplorationSurface(root, ["**"], []);
    const admitted = [...surface.baseline.keys()].sort();
    assert.deepEqual(admitted, ["main.ts", "vendor/dep/index.js"]);
    assert.ok(!admitted.some((file) => file.split("/").includes(".git")));
    assert.ok(!admitted.some((file) => file.split("/").includes(".sol-luna")));
  } finally {
    if (surface) await removeExplorationSurface(surface);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grounding accepts a truthful citation of a line whose text repeats earlier", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-explore-ground-"));
  let surface: Awaited<ReturnType<typeof createExplorationSurface>> | null = null;
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    // The same statement on lines 1 and 3: entirely ordinary in real source.
    await fs.writeFile(
      path.join(root, "src", "repeat.ts"),
      "export const x = 1;\nconst other = 2;\nexport const x = 1;\n",
    );
    surface = await createExplorationSurface(root, ["src/**"], []);

    assert.equal(
      await verifyGrounding(surface, "src/repeat.ts", 1, "export const x = 1;"),
      null,
    );
    // The later occurrence is just as true; matching only the first hit reported
    // it as ungrounded and quietly demoted a correct worker fact.
    assert.equal(
      await verifyGrounding(surface, "src/repeat.ts", 3, "export const x = 1;"),
      null,
    );
    // A line that holds neither occurrence is still rejected.
    assert.match(
      (await verifyGrounding(surface, "src/repeat.ts", 2, "export const x = 1;")) ?? "",
      /not claimed line 2/,
    );
  } finally {
    if (surface) await removeExplorationSurface(surface);
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Admission consistency between the surface and reported claims ----------

/** A workspace holding one admitted file plus repository metadata and secrets. */
async function surfaceFixture(): Promise<{ root: string; surface: ExplorationSurface }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-admit-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "log.ts"), "export const logger = 1;\n");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "config"), "[remote]\n url = https://x\n");
  await fs.writeFile(path.join(root, ".env"), "API_KEY=secret\n");
  // `scope: ["**"]` is the broadest admission a caller can declare, and the one
  // that makes the two answers to "is this in scope" disagree.
  const surface = await createExplorationSurface(root, ["**"], []);
  return { root, surface };
}

const reportWith = (overrides: Partial<ExploreReport>): ExploreReport => ({
  status: "PASS",
  summary: "",
  observedFacts: [],
  inferences: [],
  unknowns: [],
  relevantFiles: [],
  recommendedSeams: [],
  notes: "",
  ...overrides,
});

const admissionInput = (): ExploreInput =>
  exploreInputSchema.parse({
    target: "Report which files matter for the logging seam",
    effortReason: "Deterministic admission-consistency probe",
    scope: ["**"],
  });

test("repository metadata and secrets never reappear as reported paths", async () => {
  // `createExplorationSurface` refuses to copy `.git` and `.env` at any depth.
  // Claim validation checked only the caller's `scope`, so under `**` a worker
  // could name them back and have them echoed as in-scope findings — two
  // different answers from the same admission decision.
  const { root, surface } = await surfaceFixture();
  try {
    assert.equal(surface.baseline.has(".git/config"), false, "fixture assumption");
    assert.equal(surface.baseline.has(".env"), false, "fixture assumption");

    const validated = await validateExploreFindings(
      admissionInput(),
      surface,
      reportWith({
        relevantFiles: [
          { path: "src/log.ts", why: "the admitted file" },
          { path: ".git/config", why: "claimed remote URL" },
          { path: ".env", why: "claimed credentials" },
        ],
        recommendedSeams: [
          {
            label: "logging",
            description: "advisory seam",
            candidateFiles: ["src/log.ts", ".git/config", ".env", "../outside.ts"],
          },
        ],
      }),
      [],
    );

    assert.deepEqual(
      validated.findings?.relevantFiles.map((file) => file.path),
      ["src/log.ts"],
    );
    // Advisory seam candidates were previously checked for scope but never for
    // surface membership, so they were the looser of the two lists.
    assert.deepEqual(validated.findings?.recommendedSeams[0]?.candidateFiles, [
      "src/log.ts",
    ]);
    for (const discarded of [".git/config", ".env", "../outside.ts"]) {
      assert.ok(
        validated.discrepancies.some((entry) => entry.includes(discarded)),
        `${discarded} must be reported as discarded`,
      );
    }
  } finally {
    await removeExplorationSurface(surface);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grounding fails closed when the surface could not be proven unmodified", async () => {
  // A mutation scan that throws leaves surface integrity *unknown*, not proven.
  // Treating an empty mutation list as "pristine" meant a worker able to break
  // the scan got its edited copy read as the original, and its claims stamped
  // `runtime-verified`.
  const { root, surface } = await surfaceFixture();
  try {
    const report = reportWith({
      observedFacts: [
        {
          statement: "The logger is exported.",
          sourceFile: "src/log.ts",
          sourceLine: 1,
          evidence: "export const logger = 1;",
        },
      ],
    });

    // Control: a clean scan grounds the truthful claim.
    const clean = await validateExploreFindings(admissionInput(), surface, report, []);
    assert.equal(clean.findings?.observedFacts[0]?.grounding, "runtime-verified");
    assert.deepEqual(clean.discrepancies, []);

    // A failed scan discards it, even though the evidence text is genuinely
    // present in the surface as it stands now.
    const unknown = await validateExploreFindings(
      admissionInput(),
      surface,
      report,
      [],
      "EPERM: evidence scan failed",
    );
    assert.equal(unknown.findings?.observedFacts.length, 0);
    assert.ok(
      unknown.discrepancies.some((entry) => /could not be proven unmodified/.test(entry)),
      `expected an integrity-unknown discrepancy, got ${JSON.stringify(unknown.discrepancies)}`,
    );
    assert.equal(unknown.findings?.runtimeObservedFacts.length, 0);
  } finally {
    await removeExplorationSurface(surface);
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Credential files are never copied into the surface ---------------------

test("credential-bearing files are never admitted into the exploration surface", async () => {
  // The invariant: exploration copies real bytes into a surface a model then
  // reads, so a file whose documented purpose is to hold a secret must never be
  // admitted — including under the broadest scope a caller can declare.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-creds-"));
  try {
    const secrets = [
      ".env",
      ".env.production",
      ".envrc",
      ".npmrc",
      ".netrc",
      "_netrc",
      ".git-credentials",
      "packages/api/.env",
      "packages/api/.npmrc",
      "vendor/tool/.envrc",
    ];
    await fs.mkdir(path.join(root, "packages", "api"), { recursive: true });
    await fs.mkdir(path.join(root, "vendor", "tool"), { recursive: true });
    await fs.mkdir(path.join(root, ".aws"), { recursive: true });
    for (const secret of [...secrets, ".aws/credentials"]) {
      await fs.writeFile(path.join(root, ...secret.split("/")), "TOKEN=super-secret\n");
    }
    // Ordinary files that must still be admitted; over-matching here would
    // silently blind exploration to real source.
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "env.ts"), "export const env = 1;\n");
    await fs.writeFile(path.join(root, "environment.md"), "# environment\n");
    await fs.writeFile(
      path.join(root, "src", "netrc-parser.ts"),
      "export const p = 1;\n",
    );

    const surface = await createExplorationSurface(root, ["**"], []);
    try {
      for (const secret of [...secrets, ".aws/credentials"]) {
        assert.equal(
          surface.baseline.has(secret),
          false,
          `${secret} must not reach the surface`,
        );
        await assert.rejects(
          fs.stat(path.join(surface.path, ...secret.split("/"))),
          `${secret} must not exist on disk in the surface`,
        );
      }
      for (const ordinary of ["src/env.ts", "environment.md", "src/netrc-parser.ts"]) {
        assert.equal(
          surface.baseline.has(ordinary),
          true,
          `${ordinary} is an ordinary file and must still be admitted`,
        );
      }
    } finally {
      await removeExplorationSurface(surface);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a worker cannot report a credential file back as an in-scope finding", async () => {
  // Surface construction and claim validation must give the same answer. A
  // path that was refused admission cannot re-enter as a reported finding.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-creds-claim-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=secret\n");
    await fs.writeFile(path.join(root, ".envrc"), "export TOKEN=secret\n");

    const surface = await createExplorationSurface(root, ["**"], []);
    try {
      const input = exploreInputSchema.parse({
        target: "Report which files matter for the packaging seam",
        effortReason: "Deterministic credential-admission probe",
        scope: ["**"],
      });
      const validated = await validateExploreFindings(
        input,
        surface,
        {
          status: "PASS",
          summary: "",
          observedFacts: [],
          inferences: [],
          unknowns: [],
          relevantFiles: [
            { path: "src/a.ts", why: "admitted" },
            { path: ".npmrc", why: "claimed registry token" },
            { path: ".envrc", why: "claimed exported token" },
          ],
          recommendedSeams: [
            {
              label: "packaging",
              description: "advisory",
              candidateFiles: ["src/a.ts", ".npmrc", ".envrc"],
            },
          ],
          notes: "",
        },
        [],
      );

      assert.deepEqual(
        validated.findings?.relevantFiles.map((file) => file.path),
        ["src/a.ts"],
      );
      assert.deepEqual(validated.findings?.recommendedSeams[0]?.candidateFiles, [
        "src/a.ts",
      ]);
      for (const secret of [".npmrc", ".envrc"]) {
        assert.ok(
          validated.discrepancies.some((entry) => entry.includes(secret)),
          `${secret} must be reported as discarded`,
        );
      }
    } finally {
      await removeExplorationSurface(surface);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
