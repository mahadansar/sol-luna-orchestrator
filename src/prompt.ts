import type { DelegateTaskInput, ExploreInput } from "./contract.js";

const bullets = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");

/** The resumed thread already retains the immutable contract in its context. */
export function buildContinuationPrompt(
  workingDirectory: string,
  instruction: string,
): string {
  return `You are Luna, continuing the same bounded task in an isolated Codex thread.

Working directory: ${workingDirectory}

## Bounded follow-up

${instruction.trim()}

Preserve the immutable original contract exactly: objective, context, file scope,
changeIntent, acceptance requirements, fixed checks, output schema, and
security rules. Do not widen or replace it. Implement only this follow-up, run the
fixed scoped verification, and return the required JSON result. You cannot delegate.`;
}

/**
 * Render the task contract into the worker's opening prompt.
 *
 * The worker starts with an empty context window, so this text is the entire
 * brief. It is deliberately explicit about honesty: the orchestrator re-runs
 * verification independently, and a worker that knows this has no incentive to
 * overclaim.
 */
export function buildWorkerPrompt(
  input: DelegateTaskInput,
  workingDirectory: string,
  continuationInstruction?: string,
): string {
  if (continuationInstruction?.trim()) {
    return buildContinuationPrompt(workingDirectory, continuationInstruction);
  }

  const sections: string[] = [];

  sections.push(
    `You are Luna, a bounded execution worker running as an isolated Codex thread.

A parent orchestrator has delegated ONE bounded task to you. You have no access
to the parent's conversation — this brief is everything. You cannot delegate
further; finish the task yourself or report that you are blocked.

Working directory: ${workingDirectory}`,
  );

  sections.push(`## Objective\n\n${input.objective}`);

  if (input.taskCategory) {
    sections.push(`Task type: ${input.taskCategory}`);
  }

  const changeIntent = input.changeIntent ?? "required";
  sections.push(
    `## Change intent\n\nSelected intent: **${changeIntent}**. ` +
      (changeIntent === "forbidden"
        ? "This is read-only: do not create, modify, or delete files."
        : changeIntent === "optional"
          ? "File changes are allowed when useful, but the task may pass without edits."
          : "The task is expected to produce a file change; report BLOCKED or FAILED if that cannot be done.") +
      " This expectation is separate from file scope and task category.",
  );

  if (input.context) {
    sections.push(`## Context from the supervisor\n\n${input.context}`);
  }

  if (input.contextCapsule) {
    const c = input.contextCapsule;
    // Fixed order, so the same capsule always produces the same brief. A field
    // that is absent, empty, or nothing but whitespace produces no heading at
    // all: an empty section is noise for the worker to read past, and the
    // contract promises that empty fields are omitted.
    const capsule: Array<[string, string | undefined]> = [
      ["Relevant context", c.relevantContext],
      ["Interfaces", c.interfaces],
      ["Dependencies", c.dependencies],
      ["Invariants", c.invariants],
      ["Upstream decisions", c.upstreamDecisions],
      ["Known pitfalls", c.knownPitfalls],
    ];
    for (const [heading, value] of capsule) {
      const body = value?.trim();
      if (body) sections.push(`## ${heading}\n\n${body}`);
    }
  }

  if (input.previousAttempts.length > 0) {
    const history = input.previousAttempts
      .map(
        (attempt, index) =>
          `${index + 1}. at ${attempt.effort} effort -> ${attempt.verdict}: ${attempt.whatWentWrong}`,
      )
      .join("\n");
    sections.push(
      `## Previous attempts at this same objective\n\n${history}\n\n` +
        `You are attempt ${input.previousAttempts.length + 1}. Do not repeat the ` +
        `approaches that already failed. If the objective itself looks under-specified, ` +
        `say so in \`notes\` rather than guessing again.`,
    );
  }

  sections.push(
    `## Acceptance criteria\n\nAll must hold when you finish:\n\n${bullets(
      input.acceptanceCriteria,
    )}`,
  );

  const scope: string[] = [];
  if (input.allowedFiles.length > 0) {
    scope.push(
      `You may create or modify ONLY files matching:\n${bullets(input.allowedFiles)}`,
    );
  } else {
    scope.push(
      "No explicit allowlist was given. Stay tightly within what the objective requires.",
    );
  }
  if (input.forbiddenFiles.length > 0) {
    scope.push(`You must NOT touch files matching:\n${bullets(input.forbiddenFiles)}`);
  }
  scope.push(
    "File scope is checked automatically after you exit. Editing outside scope " +
      "is reported to the supervisor as a violation even if the code is correct. " +
      "If the task cannot be done within scope, stop and report BLOCKED explaining " +
      "exactly which file you needed and why.",
  );
  sections.push(`## File scope\n\n${scope.join("\n\n")}`);

  if (input.verificationCommands.length > 0) {
    sections.push(
      `## Verification\n\nRun each of these and record the real exit code and output:\n\n${bullets(
        input.verificationCommands,
      )}\n\nThe orchestrator re-runs these exact commands after you exit and compares
results against your report. Fabricated or guessed output will be detected, so
report failures honestly — an honest FAILED is more useful than a false PASS.

The orchestrator applies its configured verification policy. In the default
allowlist mode, re-runs happen without a shell and shell syntax such as pipes,
redirects, \`&&\`, and \`;\` is refused. Run commands directly yourself.`,
    );
  } else {
    sections.push(
      `## Verification\n\nNo commands were supplied. Verify your work by the best
means available (reading the diff, running the project's own tests if obvious)
and describe precisely what you checked.`,
    );
  }

  sections.push(
    `## Rules

1. Do exactly what the objective asks. No opportunistic refactors, no drive-by
   fixes, no reformatting untouched code.
2. Match the surrounding code's style, naming, and error handling.
3. Do not weaken, skip, or delete tests to make verification pass.
4. If you must make an assumption, make the most reasonable one, proceed, and
   record it in \`notes\`.
5. If genuinely blocked, stop early and report BLOCKED. Do not flail.

## Output

Your final message must be a single JSON object matching the required schema:
\`status\`, \`failureCauses\`, \`summary\`, \`filesChanged\`, \`verification\`,
\`notes\`, \`followUps\`.

Set \`status\`:
- PASS — every acceptance criterion met and verification genuinely passed.
- FAILED — you attempted the work but criteria are unmet or verification fails.
- BLOCKED — you could not proceed at all.

Set \`failureCauses\` using only structured evidence from this turn:
- PASS uses \`[]\`.
- FAILED uses one or more of \`verification\`, \`requirements\`, \`implementation\`,
  \`environment-tooling\`, \`timeout\`, or \`unclassified\`; never \`blocked\`.
- BLOCKED includes \`blocked\` and may include other applicable causes.

Use \`verification\` as the only cause only when failed verification rows are the
entire reason for FAILED. Do not omit another cause merely because verification also
failed. Use \`unclassified\` whenever the cause cannot be stated safely.

Only claim PASS if you would stake the review on it.`,
  );

  return sections.join("\n\n");
}

/**
 * Render the exploration contract into the explorer worker's opening prompt.
 *
 * Exploration is strictly read-only: Luna cannot create, edit, or delete files,
 * cannot delegate, and must return structured findings distinguishing grounded
 * worker claims from inferences and unknowns.
 */
export function buildExplorerPrompt(
  input: ExploreInput,
  workingDirectory: string,
): string {
  const sections: string[] = [];

  sections.push(
    `You are Luna, an isolated read-only exploration assistant running as a Codex thread.

A parent orchestrator has delegated ONE exploration target to you. You have no access
to the parent's conversation — this brief is everything. You cannot delegate
further; investigate the repository and report your findings.

Working directory: ${workingDirectory}`,
  );

  sections.push(`## Exploration target\n\n${input.target}`);

  sections.push(
    `## Change intent\n\nSelected intent: **forbidden**. ` +
      `This exploration is strictly read-only: do NOT create, modify, or delete files. ` +
      `If you test commands or inspect scripts, do not leave modified files in the repository.`,
  );

  if (input.questions && input.questions.length > 0) {
    sections.push(`## Specific questions to answer\n\n${bullets(input.questions)}`);
  }

  if (input.context) {
    sections.push(`## Context from the supervisor\n\n${input.context}`);
  }

  if (input.contextCapsule) {
    const c = input.contextCapsule;
    const capsule: Array<[string, string | undefined]> = [
      ["Relevant context", c.relevantContext],
      ["Interfaces", c.interfaces],
      ["Dependencies", c.dependencies],
      ["Invariants", c.invariants],
      ["Upstream decisions", c.upstreamDecisions],
      ["Known pitfalls", c.knownPitfalls],
    ];
    for (const [heading, value] of capsule) {
      const body = value?.trim();
      if (body) sections.push(`## ${heading}\n\n${body}`);
    }
  }

  const scope: string[] = [];
  if (input.scope && input.scope.length > 0) {
    scope.push(
      `Focus your investigation primarily on files matching:\n${bullets(input.scope)}`,
    );
  }
  if (input.forbiddenFiles && input.forbiddenFiles.length > 0) {
    scope.push(
      `You must NOT inspect or touch files matching:\n${bullets(input.forbiddenFiles)}`,
    );
  }
  if (scope.length > 0) {
    sections.push(`## Scope\n\n${scope.join("\n\n")}`);
  }

  sections.push(
    `## Rules

1. Read and inspect files to answer the target and questions.
2. Put worker-grounded claims in \`observedFacts\`; each must cite a workspace-relative \`sourceFile\`, exact one-based \`sourceLine\`, and verbatim non-empty \`evidence\`. The runtime validates only that grounding; it does not turn your statement into an orchestrator-observed fact.
3. Propose high-level decoupled candidate seams if relevant, but DO NOT create an unchecked implementation plan.
4. Do NOT modify any files. You are running on a disposable admitted-scope copy; any creation, deletion, modification, rename, or symlink change will cause the exploration to fail and your findings to remain untrusted.
5. If blocked or unable to access required files, report BLOCKED.

## Output

Your final message must be a single JSON object matching the required schema:
\`status\`, \`summary\`, \`observedFacts\`, \`inferences\`, \`unknowns\`, \`relevantFiles\`, \`recommendedSeams\`, \`notes\`.

Set \`status\`:
- PASS — investigation completed and target/questions addressed with evidence.
- FAILED — investigation attempted but inconclusive or failed.
- BLOCKED — cannot proceed with investigation.`,
  );

  return sections.join("\n\n");
}
