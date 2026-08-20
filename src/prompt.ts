import type { DelegateTaskInput } from "./contract.js";

const bullets = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");

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
): string {
  const sections: string[] = [];

  sections.push(
    `You are Luna, an implementation worker running as an isolated Codex thread.

A supervisor agent (Sol) has delegated ONE bounded task to you. You have no
access to Sol's conversation — this brief is everything. You cannot delegate
further; finish the task yourself or report that you are blocked.

Working directory: ${workingDirectory}`,
  );

  sections.push(`## Objective\n\n${input.objective}`);

  if (input.taskCategory) {
    sections.push(`Task type: ${input.taskCategory}`);
  }

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

Those re-runs happen without a shell: only the listed executable is launched, and
pipes, redirects, \`&&\` and \`;\` are refused. Run them the same way yourself.`,
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
\`status\`, \`summary\`, \`filesChanged\`, \`verification\`, \`notes\`, \`followUps\`.

Set \`status\`:
- PASS — every acceptance criterion met and verification genuinely passed.
- FAILED — you attempted the work but criteria are unmet or verification fails.
- BLOCKED — you could not proceed at all.

Only claim PASS if you would stake the review on it.`,
  );

  return sections.join("\n\n");
}
