/**
 * P2.3 End-to-End Automated Workflow Engine.
 *
 * Provides a bounded, supervisor-driven capstone workflow that coordinates
 * task intake, optional exploration, semantic decomposition / adaptive routing,
 * zero-worker solo resolution, single / batch delegation, authoritative verification,
 * P1.1 failure classification, bounded repair / recovery / continuation, and
 * evidence-earned next-action escalation without creating a second orchestration system.
 *
 * Reuses existing P1/P2 primitives directly:
 * - Admission & compute policy (`admitCompute`)
 * - Semantic seam planning and adaptive routing (`routeAdaptiveTask`)
 * - Optional explorer (`handleExplore`)
 * - Worker / batch execution (`handleDelegateTask`, `handleDelegateTasks`)
 * - Continuation (`handleContinueTask`, `ContinuationStore`)
 * - Evidence-earned next-action handoffs (`HandoffStore`)
 * - Automatic context lifecycle management (`ContextLifecycleStore`, `ContextLifecycleRegistry`)
 * - Cross-session informational handoff (`ContextLifecycleRegistry.restoreSessionHandoff`)
 */
import {
  type BatchOutput,
  type ChangeIntent,
  type DelegateTaskInput,
  type DelegateTaskOutput,
  type DelegateTasksInput,
  type ExploreInput,
  type ExploreOutput,
  type FailureDecision,
  type RoutingPreflightInput,
  type TaskCategory,
  exploreInputSchema,
} from "./contract.js";
import { admitCompute, type ComputePolicy } from "./policy.js";
import {
  deriveDeclaredEvidence,
  deriveSeamCandidate,
  deriveSeamCandidates,
  routeAdaptiveTask,
  type AdaptiveRoutingResult,
} from "./adaptive.js";
import type { SeamCandidate } from "./seam-plan.js";
import type { ExecutionShape, RoutingRoute } from "./routing.js";
import { emitEvent, type EventEmitter } from "./events.js";
import { ContextLifecycleStore } from "./context.js";
import { ContinuationStore } from "./continuation.js";
import { HandoffStore } from "./handoff.js";
import type { SessionHandoffArtifact } from "./session-handoff.js";
import {
  ContextLifecycleRegistry,
  handleContinueTask,
  handleDelegateTask,
  handleDelegateTasks,
  handleExplore,
  isAuthoritativelyVerifiedPass,
} from "./server.js";
import type { Effort } from "./config.js";

/** Explicit states of the end-to-end workflow state machine. */
export const WORKFLOW_STATES = [
  "assessing",
  "exploring",
  "routing",
  "solo",
  "delegating",
  "evaluating",
  "continuing",
  "escalating",
  "completed",
  "failed",
  "blocked",
  "parent_takeover",
  "cancelled",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Terminal outcome status of the automated workflow. */
export const WORKFLOW_STATUSES = [
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "PARENT_TAKEOVER",
  "CANCELLED",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Recorded execution step within a workflow. */
export interface WorkflowStep {
  readonly stepNumber: number;
  readonly state: WorkflowState;
  readonly action: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure" | "blocked" | "inconclusive" | "noop";
  readonly details?: Record<string, unknown>;
}

/** State transition record within a workflow. */
export interface WorkflowTransition {
  readonly fromState: WorkflowState;
  readonly toState: WorkflowState;
  readonly reason: string;
  readonly timestamp: string;
  readonly stepNumber: number;
}

/** Contract for initiating an automated end-to-end workflow. */
export interface WorkflowInput {
  readonly objective: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly allowedFiles?: readonly string[];
  readonly forbiddenFiles?: readonly string[];
  readonly changeIntent?: ChangeIntent;
  readonly taskCategory?: TaskCategory;
  readonly verificationCommands?: readonly string[];
  readonly activityLabel?: string;
  readonly context?: string;
  readonly contextCapsule?: {
    readonly relevantContext?: string;
    readonly interfaces?: string;
    readonly dependencies?: string;
    readonly invariants?: string;
    readonly upstreamDecisions?: string;
    readonly knownPitfalls?: string;
  };
  /** Pre-decomposed task contracts if supervisor already partitioned the work. */
  readonly tasks?: readonly DelegateTaskInput[];
  /** Optional exploration companion request or options. */
  readonly explore?: boolean | ExploreInput;
  /** Optional routing preflight declarations. */
  readonly routingPreflight?: RoutingPreflightInput;
  /** Optional compute policy narrowing. */
  readonly computePolicy?: Partial<ComputePolicy>;
  /** Optional caller-supplied session handoff from P2.2. */
  readonly sessionHandoff?: string | SessionHandoffArtifact;
  /** Optional follow-up instruction for continuations if continuationReference is provided. */
  readonly continuationInstruction?: string;
  readonly automaticRepair?: boolean;
  readonly automaticRecovery?: boolean;
  readonly allowOverlappingScopes?: boolean;
  readonly executionMode?: "auto" | "single" | "sequential" | "parallel" | "solo";
  readonly maxSteps?: number;
  readonly maxEscalations?: number;
  readonly maxContinuations?: number;
  readonly workingDirectory?: string;
  readonly resultDetail?: "handoff" | "compact" | "full";
  readonly contextKey?: string;
}

/** Structured output returned from an automated end-to-end workflow execution. */
export interface WorkflowOutput {
  readonly workflowId: string;
  readonly status: WorkflowStatus;
  readonly state: WorkflowState;
  readonly summary: string;
  readonly verified: boolean;
  readonly durationMs: number;
  readonly executionMode: string;
  readonly recommendedRoute?: RoutingRoute;
  readonly recommendedShape?: ExecutionShape;
  readonly selectedModel?: string | null;
  readonly selectedEffort?: Effort | null;
  /** Compute observed on authoritative execution results, not routing advice. */
  readonly executedModels: readonly string[];
  readonly executedEfforts: readonly Effort[];
  readonly steps: readonly WorkflowStep[];
  readonly transitions: readonly WorkflowTransition[];
  readonly result?: DelegateTaskOutput | BatchOutput | null;
  readonly exploreResult?: ExploreOutput | null;
  readonly failureDecision?: FailureDecision | null;
  readonly contextKey: string;
  readonly continuationReference?: string | null;
  readonly handoffReference?: string | null;
}

/** Pluggable dependencies for deterministic workflow testing. */
export interface WorkflowDependencies {
  emit: EventEmitter;
  handoffStore: HandoffStore;
  continuationStore: ContinuationStore;
  contextRegistry: ContextLifecycleRegistry;
  contextStore?: ContextLifecycleStore;
  handleExplore: typeof handleExplore;
  handleDelegateTask: typeof handleDelegateTask;
  handleDelegateTasks: typeof handleDelegateTasks;
  handleContinueTask: typeof handleContinueTask;
  makeWorkflowId: () => string;
}

function makeDefaultWorkflowId(): string {
  return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Check if a state is terminal. */
export function isTerminalState(state: WorkflowState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "blocked" ||
    state === "parent_takeover" ||
    state === "cancelled"
  );
}

function boundedCount(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 0), ceiling);
}

/**
 * Execute one bounded, supervisor-driven automated workflow end-to-end.
 *
 * Implements P2.3 automated lifecycle:
 * 1. Initial assessment (and session-handoff context intake)
 * 2. Optional exploration companion
 * 3. Semantic decomposition & adaptive routing
 * 4. Zero-worker solo resolution
 * 5. Single / batch delegation
 * 6. Authoritative verification
 * 7. P1.1 failure classification
 * 8. Bounded repair / recovery / continuation
 * 9. Evidence-earned next-action handoff & escalation
 * 10. Final verified completion or parent takeover
 */
export async function executeWorkflow(
  input: WorkflowInput,
  signal?: AbortSignal,
  overrides: Partial<WorkflowDependencies> = {},
): Promise<WorkflowOutput> {
  const defaultHandoffStore = overrides.handoffStore ?? new HandoffStore();
  const defaultContinuationStore = overrides.continuationStore ?? new ContinuationStore();
  const defaultEmit = overrides.emit ?? emitEvent;
  const defaultRegistry =
    overrides.contextRegistry ??
    new ContextLifecycleRegistry({
      handoffStore: defaultHandoffStore,
      continuationStore: defaultContinuationStore,
      emit: defaultEmit,
    });

  const deps: WorkflowDependencies = {
    emit: defaultEmit,
    handoffStore: defaultHandoffStore,
    continuationStore: defaultContinuationStore,
    contextRegistry: defaultRegistry,
    handleExplore,
    handleDelegateTask,
    handleDelegateTasks,
    handleContinueTask,
    makeWorkflowId: makeDefaultWorkflowId,
    ...overrides,
  };

  const workflowId = deps.makeWorkflowId();
  const startedAt = Date.now();
  // A workflow is a current-session authority boundary. A caller label may aid
  // correlation, but must not make concurrent runs share canonical context.
  const contextKey = input.contextKey ? `${input.contextKey}:${workflowId}` : workflowId;

  // Resolve compute policy envelope
  const admission = admitCompute({
    requested: input.computePolicy,
    model: "gpt-5.6-luna",
    efforts: ["high"],
    workerCount: input.tasks?.length ?? 1,
  });
  const activeComputePolicy = admission.policy;
  // The ordinary MCP handoff fast path intentionally omits structured content
  // on clean success. A coordinator must retain compact authoritative evidence
  // to evaluate terminal truth; this does not rerun verification.
  const internalResultDetail = input.resultDetail === "full" ? "full" : "compact";

  // Context Lifecycle Store setup
  let lifecycleStore: ContextLifecycleStore;
  if (input.sessionHandoff) {
    const restored = deps.contextRegistry.restoreSessionHandoff(
      contextKey,
      input.sessionHandoff,
    );
    lifecycleStore = deps.contextStore ?? restored.store;
  } else {
    lifecycleStore = deps.contextStore ?? deps.contextRegistry.getOrCreate(contextKey);
  }

  // Acquire execution lease
  const releaseExecutionLease = lifecycleStore.acquireExecutionLease();
  let executionLeaseActive = true;
  const releaseLease = (): void => {
    if (!executionLeaseActive) return;
    executionLeaseActive = false;
    releaseExecutionLease();
  };

  // State machine variables
  let currentState: WorkflowState = "assessing";
  const steps: WorkflowStep[] = [];
  const transitions: WorkflowTransition[] = [];
  let stepNumber = 0;

  // Guard bounds
  const maxSteps = boundedCount(input.maxSteps, 10, 20);
  const maxEscalations = boundedCount(input.maxEscalations, 2, 5);
  const maxContinuations = boundedCount(input.maxContinuations, 1, 3);
  let escalationCount = 0;
  let continuationCount = 0;

  // Execution tracking
  let exploreResult: ExploreOutput | null = null;
  let routingResult: AdaptiveRoutingResult | null = null;
  let finalTaskResult: DelegateTaskOutput | null = null;
  let finalBatchResult: BatchOutput | null = null;
  let lastFailureDecision: FailureDecision | null = null;
  let activeContinuationRef: string | null = null;
  let activeHandoffRef: string | null = null;
  let resolvedMechanism: string = "solo";
  let explorationAttempted = false;
  let delegationAttempted = false;
  let escalationAttempted = false;

  // Transition helper
  function transitionTo(
    nextState: WorkflowState,
    reason: string,
    recommendation?: {
      recommendedMode?: string;
      recommendedWorkerCount?: number;
      recommendedConcurrency?: number;
      recommendedEffort?: string | null;
      selectedModel?: string | null;
      selectedEffort?: string | null;
    },
  ): void {
    const from = currentState;
    currentState = nextState;
    transitions.push({
      fromState: from,
      toState: nextState,
      reason,
      timestamp: new Date().toISOString(),
      stepNumber,
    });
    deps.emit({
      type: "workflow.transition",
      workflowId,
      batchId: workflowId,
      fromState: from,
      toState: nextState,
      reasonCode: `${from}-to-${nextState}`,
      stepNumber,
      ...recommendation,
    });
  }

  // Emit workflow started event
  deps.emit({
    type: "workflow.started",
    workflowId,
    batchId: workflowId,
    taskCount: input.tasks?.length ?? 1,
    requestedMode: input.executionMode ?? "auto",
    requestedWorkerCount: input.tasks?.length ?? 1,
    requestedModels: input.computePolicy?.allowedModels ?? [],
    requestedEfforts: input.tasks?.map((task) => task.effort) ?? [],
    maxSteps,
    maxEscalations,
    maxContinuations,
    importedContext: Boolean(input.sessionHandoff),
    computePolicy: activeComputePolicy,
  });

  try {
    while (!isTerminalState(currentState)) {
      stepNumber++;
      if (stepNumber > maxSteps) {
        transitionTo(
          "parent_takeover",
          `workflow-step-limit-exceeded (${maxSteps} steps limit)`,
        );
        break;
      }

      if (signal?.aborted) {
        transitionTo("cancelled", "external-cancellation");
        break;
      }

      const stepStart = Date.now();
      const stateToExecute: WorkflowState = currentState;

      switch (stateToExecute as string) {
        case "assessing": {
          // Input contract validation & initial context setup
          if (!input.objective || input.objective.trim().length === 0) {
            transitionTo(
              "parent_takeover",
              "Task objective is required and cannot be empty",
            );
            steps.push({
              stepNumber,
              state: "assessing",
              action: "assess-contract",
              startedAt: new Date(stepStart).toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - stepStart,
              outcome: "failure",
              details: { reason: "empty-objective" },
            });
            break;
          }

          if (input.explore) {
            transitionTo("exploring", "exploration-requested");
          } else if (input.executionMode === "solo") {
            transitionTo("solo", "supervisor-requested-solo");
          } else {
            transitionTo("routing", "proceed-to-routing");
          }

          steps.push({
            stepNumber,
            state: "assessing",
            action: "assess-contract",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome: "success",
            details: {
              objectiveLength: input.objective.length,
              hasTasks: (input.tasks?.length ?? 0) > 0,
              hasSessionHandoff: Boolean(input.sessionHandoff),
            },
          });
          break;
        }

        case "exploring": {
          let outcome: WorkflowStep["outcome"] = "success";
          const details: Record<string, unknown> = {};

          try {
            explorationAttempted = true;
            const parsedExploreInput =
              typeof input.explore === "object"
                ? exploreInputSchema.parse({
                    ...input.explore,
                    workingDirectory: input.workingDirectory,
                    resultDetail: internalResultDetail,
                  })
                : exploreInputSchema.parse({
                    target: `Investigate codebase for: ${input.objective}`,
                    effort: "high",
                    effortReason: "Workflow exploration before decomposition",
                    scope:
                      input.allowedFiles && input.allowedFiles.length > 0
                        ? [...input.allowedFiles]
                        : ["**"],
                    forbiddenFiles: input.forbiddenFiles ? [...input.forbiddenFiles] : [],
                    workingDirectory: input.workingDirectory,
                    resultDetail: internalResultDetail,
                  });

            const exploreRes = await deps.handleExplore(parsedExploreInput, signal, {
              contextStore: lifecycleStore,
              contextRegistry: deps.contextRegistry,
              emit: deps.emit,
            });

            if (exploreRes.structuredContent) {
              exploreResult = exploreRes.structuredContent as ExploreOutput;
              details.verdict = exploreResult.verdict;
              details.groundedFacts = exploreResult.findings.observedFacts.length;
              details.recommendedSeams = exploreResult.findings.recommendedSeams.length;
            } else if (exploreRes.isError) {
              outcome = "inconclusive";
              details.error = exploreRes.content[0]?.text ?? "explore-error";
            }
          } catch (error) {
            outcome = "failure";
            details.error = (error as Error).message;
          }

          steps.push({
            stepNumber,
            state: "exploring",
            action: "read-only-exploration",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome,
            details,
          });

          transitionTo("routing", "exploration-completed");
          break;
        }

        case "routing": {
          let candidates: readonly SeamCandidate[];

          if (input.tasks && input.tasks.length > 0) {
            candidates = deriveSeamCandidates(input.tasks);
          } else {
            candidates = [
              deriveSeamCandidate(
                {
                  objective: input.objective,
                  acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
                  allowedFiles: [...(input.allowedFiles ?? [])],
                  forbiddenFiles: [...(input.forbiddenFiles ?? [])],
                  changeIntent: input.changeIntent ?? "required",
                  verificationCommands: [...(input.verificationCommands ?? [])],
                  activityLabel: input.activityLabel,
                  taskCategory: input.taskCategory,
                  effort: "high",
                  effortReason: "Workflow routing",
                  automaticRepair: true,
                  resultDetail: "handoff",
                  previousAttempts: [],
                },
                0,
              ),
            ];
          }

          const declared = deriveDeclaredEvidence(input.routingPreflight);
          const routingRes = routeAdaptiveTask({
            candidates,
            declared,
            context: {
              mode:
                input.executionMode === "parallel"
                  ? "parallel"
                  : input.executionMode === "sequential"
                    ? "sequential"
                    : candidates.length > 1
                      ? "parallel"
                      : "single",
              taskCount: candidates.length,
              allowOverlappingScopes: input.allowOverlappingScopes,
            },
            policy: activeComputePolicy,
          });
          routingResult = routingRes;

          // Determine effective mechanism
          if (input.executionMode === "solo") {
            resolvedMechanism = "solo";
          } else if (
            input.tasks?.length === 1 &&
            (input.executionMode === undefined ||
              input.executionMode === "auto" ||
              input.executionMode === "single")
          ) {
            resolvedMechanism = "delegate_task";
          } else if (input.executionMode === "single") {
            resolvedMechanism = (input.tasks?.length ?? 0) > 1 ? "solo" : "delegate_task";
          } else if (input.executionMode === "sequential") {
            resolvedMechanism = "delegate_tasks_sequential";
          } else if (input.executionMode === "parallel") {
            resolvedMechanism = "delegate_tasks_parallel";
          } else {
            resolvedMechanism = routingRes.recommendedShape.mechanism;
          }

          // Exploration can suggest a decomposition, but only supervisor-owned
          // task contracts are executable work units. Without them the workflow
          // may delegate the original contract once, never synthesize a batch
          // from worker recommendations.
          if (!input.tasks?.length && resolvedMechanism !== "solo") {
            resolvedMechanism = "delegate_task";
          }

          steps.push({
            stepNumber,
            state: "routing",
            action: "adaptive-routing",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome: "success",
            details: {
              route: routingRes.recommendedRoute,
              mechanism: resolvedMechanism,
              workerCount: routingRes.recommendedShape.workerCount,
              concurrency: routingRes.recommendedShape.concurrency,
              selectedModel: routingRes.selectedModel,
              selectedEffort: routingRes.selectedEffort,
              signals: routingRes.evaluation.signals,
            },
          });

          if (admission.refusal) {
            transitionTo("parent_takeover", "compute-policy-refused-execution", {
              recommendedMode: routingRes.recommendedShape.mechanism,
              recommendedWorkerCount: routingRes.recommendedShape.workerCount,
              recommendedConcurrency: routingRes.recommendedShape.concurrency,
              recommendedEffort: routingRes.recommendedShape.effort,
              selectedModel: routingRes.selectedModel,
              selectedEffort: routingRes.selectedEffort,
            });
          } else if (resolvedMechanism === "solo") {
            transitionTo("solo", "supervisor-execution-required", {
              recommendedMode: routingRes.recommendedShape.mechanism,
              recommendedWorkerCount: routingRes.recommendedShape.workerCount,
              recommendedConcurrency: routingRes.recommendedShape.concurrency,
              recommendedEffort: routingRes.recommendedShape.effort,
              selectedModel: routingRes.selectedModel,
              selectedEffort: routingRes.selectedEffort,
            });
          } else {
            transitionTo("delegating", "authoritative-handler-selected", {
              recommendedMode: routingRes.recommendedShape.mechanism,
              recommendedWorkerCount: routingRes.recommendedShape.workerCount,
              recommendedConcurrency: routingRes.recommendedShape.concurrency,
              recommendedEffort: routingRes.recommendedShape.effort,
              selectedModel: routingRes.selectedModel,
              selectedEffort: routingRes.selectedEffort,
            });
          }
          break;
        }

        case "solo": {
          lifecycleStore.recordDecision({
            summary:
              "No worker execution was authorized; the supervisor must own the work",
            kind: "architectural",
          });
          steps.push({
            stepNumber,
            state: "solo",
            action: "solo-resolution",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome: "noop",
            details: { mechanism: "solo", workersEnlisted: 0 },
          });
          transitionTo("parent_takeover", "supervisor-must-perform-work");
          break;
        }

        case "delegating": {
          let outcome: WorkflowStep["outcome"] = "success";
          const details: Record<string, unknown> = {};

          if (resolvedMechanism === "delegate_task") {
            const ownedTask = input.tasks?.[0];
            const singleInput: DelegateTaskInput = ownedTask
              ? {
                  ...ownedTask,
                  acceptanceCriteria: [...ownedTask.acceptanceCriteria],
                  allowedFiles: [...ownedTask.allowedFiles],
                  forbiddenFiles: [...ownedTask.forbiddenFiles],
                  verificationCommands: [...ownedTask.verificationCommands],
                  previousAttempts: [...ownedTask.previousAttempts],
                  automaticRepair: input.automaticRepair ?? ownedTask.automaticRepair,
                  computePolicy: activeComputePolicy,
                  workingDirectory: input.workingDirectory ?? ownedTask.workingDirectory,
                  resultDetail: internalResultDetail,
                }
              : {
                  objective: input.objective,
                  acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
                  allowedFiles: [...(input.allowedFiles ?? [])],
                  forbiddenFiles: [...(input.forbiddenFiles ?? [])],
                  changeIntent: input.changeIntent ?? "required",
                  taskCategory: input.taskCategory,
                  verificationCommands: [...(input.verificationCommands ?? [])],
                  effort: routingResult?.selectedEffort ?? "high",
                  effortReason: "Automated workflow single delegation",
                  activityLabel: input.activityLabel,
                  context: input.context,
                  contextCapsule: input.contextCapsule,
                  automaticRepair: input.automaticRepair ?? true,
                  routingPreflight: input.routingPreflight,
                  computePolicy: activeComputePolicy,
                  workingDirectory: input.workingDirectory,
                  resultDetail: internalResultDetail,
                  previousAttempts: [],
                };

            delegationAttempted = true;
            const singleRes = await deps.handleDelegateTask(singleInput, signal, {
              contextStore: lifecycleStore,
              contextRegistry: deps.contextRegistry,
              handoffStore: deps.handoffStore,
              continuationStore: deps.continuationStore,
              emit: deps.emit,
            });

            if (singleRes.structuredContent) {
              finalTaskResult = singleRes.structuredContent;
              activeContinuationRef = finalTaskResult.continuationReference ?? null;
              activeHandoffRef = finalTaskResult.handoffReference ?? null;
              lastFailureDecision = finalTaskResult.failureDecision ?? null;
              details.verdict = finalTaskResult.verdict;
              details.trustworthy = finalTaskResult.trustworthy;
              details.continuation = Boolean(activeContinuationRef);
              details.handoff = Boolean(activeHandoffRef);
              transitionTo("evaluating", "single-delegation-completed");
            } else if (singleRes.isError) {
              outcome = "failure";
              details.error = singleRes.content[0]?.text ?? "single-delegation-error";
              transitionTo(
                signal?.aborted ? "cancelled" : "failed",
                signal?.aborted ? "external-cancellation" : (details.error as string),
              );
            } else {
              outcome = "inconclusive";
              transitionTo("evaluating", "single-delegation-finished");
            }
          } else {
            // Batch delegation
            const mode =
              resolvedMechanism === "delegate_tasks_parallel" ? "parallel" : "sequential";

            let batchTasks: DelegateTaskInput[];
            if (input.tasks && input.tasks.length > 0) {
              batchTasks = input.tasks.map((task) => ({
                ...task,
                allowedFiles: [...task.allowedFiles],
                forbiddenFiles: [...task.forbiddenFiles],
                acceptanceCriteria: [...task.acceptanceCriteria],
                verificationCommands: [...task.verificationCommands],
                computePolicy: activeComputePolicy,
                automaticRepair: input.automaticRepair ?? task.automaticRepair,
                previousAttempts: task.previousAttempts ?? [],
              }));
            } else {
              batchTasks = [
                {
                  objective: input.objective,
                  acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
                  allowedFiles: [...(input.allowedFiles ?? [])],
                  forbiddenFiles: [...(input.forbiddenFiles ?? [])],
                  changeIntent: input.changeIntent ?? "required",
                  taskCategory: input.taskCategory,
                  verificationCommands: [...(input.verificationCommands ?? [])],
                  effort: routingResult?.selectedEffort ?? "high",
                  effortReason: "Automated workflow batch delegation",
                  activityLabel: input.activityLabel,
                  automaticRepair: input.automaticRepair ?? true,
                  computePolicy: activeComputePolicy,
                  workingDirectory: input.workingDirectory,
                  resultDetail: internalResultDetail,
                  previousAttempts: [],
                },
              ];
            }

            const batchInput: DelegateTasksInput = {
              mode,
              tasks: batchTasks,
              workingDirectory: input.workingDirectory,
              allowOverlappingScopes: input.allowOverlappingScopes ?? false,
              automaticRecovery: input.automaticRecovery ?? true,
              integrate: true,
              routingPreflight: input.routingPreflight,
              computePolicy: activeComputePolicy,
              resultDetail: internalResultDetail,
            };

            delegationAttempted = true;
            const batchRes = await deps.handleDelegateTasks(batchInput, signal, {
              contextStore: lifecycleStore,
              contextRegistry: deps.contextRegistry,
              handoffStore: deps.handoffStore,
              continuationStore: deps.continuationStore,
              emit: deps.emit,
            });

            if (batchRes.structuredContent) {
              finalBatchResult = batchRes.structuredContent;
              details.passed = finalBatchResult.passed;
              details.total = finalBatchResult.taskCount;
              details.completionState = finalBatchResult.completionState;
              details.integrated = finalBatchResult.integrated;
              transitionTo("evaluating", "batch-delegation-completed");
            } else if (batchRes.isError) {
              outcome = "failure";
              details.error = batchRes.content[0]?.text ?? "batch-delegation-error";
              transitionTo(
                signal?.aborted ? "cancelled" : "failed",
                signal?.aborted ? "external-cancellation" : (details.error as string),
              );
            } else {
              outcome = "inconclusive";
              transitionTo("evaluating", "batch-delegation-finished");
            }
          }

          steps.push({
            stepNumber,
            state: "delegating",
            action: `execute-${resolvedMechanism}`,
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome,
            details,
          });
          break;
        }

        case "evaluating": {
          const details: Record<string, unknown> = {};

          if (finalTaskResult) {
            details.verdict = finalTaskResult.verdict;
            details.trustworthy = finalTaskResult.trustworthy;

            if (finalTaskResult.verdict === "PASS") {
              if (finalTaskResult.scopeViolations.length > 0) {
                transitionTo(
                  "parent_takeover",
                  `Scope violation detected: ${finalTaskResult.scopeViolations[0]}`,
                );
              } else if (!finalTaskResult.trustworthy) {
                transitionTo(
                  "parent_takeover",
                  "Result untrusted due to contradictions or inconsistencies",
                );
              } else if (isAuthoritativelyVerifiedPass(finalTaskResult)) {
                transitionTo("completed", "Task verified successfully");
              } else {
                transitionTo(
                  "parent_takeover",
                  "PASS result lacks complete current authoritative verification evidence",
                );
              }
            } else if (finalTaskResult.verdict === "BLOCKED") {
              transitionTo("blocked", finalTaskResult.notes || "Worker declared blocked");
            } else {
              // FAILED: Evaluate P1.1 failure decision
              const decision = lastFailureDecision ?? finalTaskResult.failureDecision;
              details.failureAction = decision?.action;
              details.failureClassification = decision?.classification;

              if (decision?.action === "continuation") {
                if (activeContinuationRef && continuationCount < maxContinuations) {
                  transitionTo("continuing", "authorized-continuation");
                } else {
                  transitionTo(
                    "parent_takeover",
                    "Continuation unavailable or limit exceeded",
                  );
                }
              } else if (
                decision?.action === "retry" ||
                decision?.action === "effort-escalation" ||
                decision?.action === "stronger-executor-fallback"
              ) {
                if (activeHandoffRef && escalationCount < maxEscalations) {
                  if (
                    decision.action === "effort-escalation" &&
                    !activeComputePolicy.allowEffortEscalation
                  ) {
                    transitionTo(
                      "parent_takeover",
                      "Effort escalation disallowed by compute policy",
                    );
                  } else if (
                    decision.action === "stronger-executor-fallback" &&
                    !activeComputePolicy.allowStrongerFallback
                  ) {
                    transitionTo(
                      "parent_takeover",
                      "Stronger executor fallback disallowed by compute policy",
                    );
                  } else {
                    transitionTo("escalating", `Authorized ${decision.action}`);
                  }
                } else {
                  transitionTo(
                    "parent_takeover",
                    "Escalation handoff unavailable or limit exceeded",
                  );
                }
              } else if (decision?.action === "stop") {
                transitionTo(
                  "failed",
                  decision.reason || "Terminal failure decision (stop)",
                );
              } else {
                transitionTo(
                  "parent_takeover",
                  decision?.reason || "Task requires parent takeover",
                );
              }
            }
          } else if (finalBatchResult) {
            details.passed = finalBatchResult.passed;
            details.total = finalBatchResult.taskCount;
            details.completionState = finalBatchResult.completionState;

            if (finalBatchResult.completionState === "verified-complete") {
              transitionTo("completed", "Batch verified complete with clean integration");
            } else {
              transitionTo(
                "parent_takeover",
                `Batch execution did not verify complete (${finalBatchResult.passed}/${finalBatchResult.taskCount} passed, completionState=${finalBatchResult.completionState})`,
              );
            }
          } else {
            transitionTo("parent_takeover", "No execution result to evaluate");
          }

          steps.push({
            stepNumber,
            state: "evaluating",
            action: "evaluate-results-and-failure-classification",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome: "success",
            details,
          });
          break;
        }

        case "continuing": {
          let outcome: WorkflowStep["outcome"] = "success";
          const details: Record<string, unknown> = {};

          if (!activeContinuationRef) {
            transitionTo("parent_takeover", "Missing continuation reference");
            break;
          }

          const instruction =
            input.continuationInstruction ||
            "Please address remaining criteria or local defect and re-verify.";
          const contRef = activeContinuationRef;
          activeContinuationRef = null;

          const contRes = await deps.handleContinueTask(
            {
              continuationReference: contRef,
              instruction,
              resultDetail: internalResultDetail,
            },
            signal,
            {
              contextStore: lifecycleStore,
              contextRegistry: deps.contextRegistry,
              store: deps.continuationStore,
              handoffStore: deps.handoffStore,
              emit: deps.emit,
            },
          );

          if (contRes.structuredContent) {
            finalTaskResult = contRes.structuredContent;
            activeContinuationRef = finalTaskResult.continuationReference ?? null;
            activeHandoffRef = finalTaskResult.handoffReference ?? null;
            lastFailureDecision = finalTaskResult.failureDecision ?? null;
            continuationCount++;
            details.verdict = finalTaskResult.verdict;
            details.continuationAttempt = continuationCount;
            transitionTo("evaluating", "continuation-turn-completed");
          } else if (contRes.isError) {
            outcome = "failure";
            details.error = contRes.content[0]?.text ?? "continuation-error";
            transitionTo(
              signal?.aborted ? "cancelled" : "parent_takeover",
              signal?.aborted ? "external-cancellation" : (details.error as string),
            );
          } else {
            outcome = "inconclusive";
            transitionTo("evaluating", "continuation-turn-finished");
          }

          steps.push({
            stepNumber,
            state: "continuing",
            action: "worker-continuation",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome,
            details,
          });
          break;
        }

        case "escalating": {
          let outcome: WorkflowStep["outcome"] = "success";
          const details: Record<string, unknown> = {};

          if (!activeHandoffRef) {
            transitionTo("parent_takeover", "Missing handoff reference");
            break;
          }

          const handoffRef = activeHandoffRef;
          activeHandoffRef = null;
          escalationAttempted = true;

          const escTask: DelegateTaskInput = {
            handoffReference: handoffRef,
            objective: input.objective,
            acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
            allowedFiles: [...(input.allowedFiles ?? [])],
            forbiddenFiles: [...(input.forbiddenFiles ?? [])],
            changeIntent: input.changeIntent ?? "required",
            verificationCommands: [...(input.verificationCommands ?? [])],
            effort: "high",
            effortReason: "Escalated delegation turn via handoff",
            automaticRepair: input.automaticRepair ?? true,
            computePolicy: activeComputePolicy,
            workingDirectory: input.workingDirectory,
            resultDetail: internalResultDetail,
            previousAttempts: [],
          };

          const escRes = await deps.handleDelegateTask(escTask, signal, {
            contextStore: lifecycleStore,
            contextRegistry: deps.contextRegistry,
            handoffStore: deps.handoffStore,
            continuationStore: deps.continuationStore,
            emit: deps.emit,
          });

          if (escRes.structuredContent) {
            finalTaskResult = escRes.structuredContent;
            activeContinuationRef = finalTaskResult.continuationReference ?? null;
            activeHandoffRef = finalTaskResult.handoffReference ?? null;
            lastFailureDecision = finalTaskResult.failureDecision ?? null;
            escalationCount++;
            details.verdict = finalTaskResult.verdict;
            details.escalationAttempt = escalationCount;
            details.model = finalTaskResult.model;
            details.effort = finalTaskResult.effort;
            transitionTo("evaluating", "escalated-turn-completed");
          } else if (escRes.isError) {
            outcome = "failure";
            details.error = escRes.content[0]?.text ?? "escalation-error";
            transitionTo(
              signal?.aborted ? "cancelled" : "parent_takeover",
              signal?.aborted ? "external-cancellation" : (details.error as string),
            );
          } else {
            outcome = "inconclusive";
            transitionTo("evaluating", "escalated-turn-finished");
          }

          steps.push({
            stepNumber,
            state: "escalating",
            action: "effort-or-stronger-executor-escalation",
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStart,
            outcome,
            details,
          });
          break;
        }

        default:
          break;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      if (!isTerminalState(currentState)) {
        transitionTo("cancelled", "external-cancellation");
      }
    } else if (!isTerminalState(currentState)) {
      transitionTo("failed", `workflow-runtime-error: ${(error as Error).message}`);
    }
  } finally {
    releaseLease();
    lifecycleStore.evaluateAndMaybeCompact("post-delegation", {
      batchId: workflowId,
      emit: deps.emit,
    });
    deps.contextRegistry.releaseIfUnreferenced(contextKey);
  }

  const durationMs = Date.now() - startedAt;

  // Map terminal state to WorkflowStatus
  let status: WorkflowStatus;
  const finalState: WorkflowState = currentState;
  switch (finalState as string) {
    case "completed":
      status = "COMPLETED";
      break;
    case "blocked":
      status = "BLOCKED";
      break;
    case "cancelled":
      status = "CANCELLED";
      break;
    case "parent_takeover":
      status = "PARENT_TAKEOVER";
      break;
    case "failed":
    default:
      status = "FAILED";
      break;
  }

  const isVerified = status === "COMPLETED";

  const summary =
    status === "COMPLETED"
      ? `Workflow verified complete in ${durationMs}ms across ${steps.length} steps.`
      : status === "PARENT_TAKEOVER"
        ? `Workflow yielded to parent takeover: ${transitions[transitions.length - 1]?.reason ?? "requires parent intervention"}`
        : status === "BLOCKED"
          ? `Workflow blocked: ${transitions[transitions.length - 1]?.reason ?? "worker or integration blocked"}`
          : status === "CANCELLED"
            ? `Workflow cancelled after ${steps.length} steps.`
            : `Workflow failed: ${transitions[transitions.length - 1]?.reason ?? "terminal failure"}`;

  // Emit workflow completed telemetry
  const executedModels = Array.from(
    new Set(
      finalTaskResult
        ? [finalTaskResult.model]
        : (finalBatchResult?.tasks.flatMap((task) =>
            task.result ? [task.result.model] : [],
          ) ?? []),
    ),
  );
  const observedEfforts = finalTaskResult
    ? [finalTaskResult.effort as Effort]
    : (finalBatchResult?.tasks.flatMap((task) =>
        task.result ? [task.result.effort as Effort] : [],
      ) ?? []);
  const executedEfforts: Effort[] = Array.from(new Set<Effort>(observedEfforts));

  deps.emit({
    type: "workflow.completed",
    workflowId,
    batchId: workflowId,
    finalState: currentState,
    status,
    durationMs,
    totalSteps: steps.length,
    passed: status === "COMPLETED",
    delegated: delegationAttempted,
    explored: explorationAttempted,
    escalated: escalationAttempted,
    executionMode: resolvedMechanism,
    executedModels,
    executedEfforts,
  });

  return {
    workflowId,
    status,
    state: currentState,
    summary,
    verified: isVerified,
    durationMs,
    executionMode: resolvedMechanism,
    recommendedRoute: routingResult?.recommendedRoute,
    recommendedShape: routingResult?.recommendedShape,
    selectedModel: routingResult?.selectedModel,
    selectedEffort: routingResult?.selectedEffort,
    executedModels,
    executedEfforts,
    steps,
    transitions,
    result: finalTaskResult ?? finalBatchResult ?? null,
    exploreResult,
    failureDecision: lastFailureDecision,
    contextKey,
    continuationReference: activeContinuationRef,
    handoffReference: activeHandoffRef,
  };
}

/** Render a concise human-readable workflow summary report. */
export function renderWorkflowReport(workflow: WorkflowOutput): string {
  const lines: string[] = [
    `WORKFLOW ${workflow.workflowId} | ${workflow.status} | ${workflow.durationMs}ms | ${workflow.steps.length} steps`,
    `MODE: ${workflow.executionMode} | VERIFIED: ${workflow.verified ? "YES" : "NO"}`,
    `SUMMARY: ${workflow.summary}`,
  ];

  if (workflow.recommendedRoute) {
    lines.push(
      `ROUTING: route=${workflow.recommendedRoute} model=${workflow.selectedModel ?? "n/a"} effort=${workflow.selectedEffort ?? "n/a"}`,
    );
  }

  lines.push("TRANSITIONS:");
  for (const t of workflow.transitions) {
    lines.push(`  [step ${t.stepNumber}] ${t.fromState} -> ${t.toState} (${t.reason})`);
  }

  if (workflow.result) {
    if ("verdict" in workflow.result) {
      lines.push(
        `TASK RESULT: verdict=${workflow.result.verdict} attempt=${workflow.result.attempt}`,
      );
    } else if ("completionState" in workflow.result) {
      lines.push(
        `BATCH RESULT: ${workflow.result.passed}/${workflow.result.taskCount} passed | ${workflow.result.completionState}`,
      );
    }
  }

  return lines.join("\n");
}
