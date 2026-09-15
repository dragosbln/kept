export type {
  PolicyAction,
  DecisionOutcome,
  PolicyRequest,
  CapOutcome,
  CapDecision,
  EligibilityRuleKind,
  EligibilityFailure,
  EligibilityVerdict,
  EligibilityContext,
  EligibilityRulesEnabled,
  DecisionRecord,
  RequireApprovalReason,
  DenyReason,
  DecisionResult,
  PlanEntry,
  DecisionPlan,
} from './types.js';
export type { CapKind } from './caps.js';
export { CAP_KINDS, CAP_REGISTRY } from './caps.js';
export type { CapConfig, PolicyEngineConfig } from './config.js';
export {
  PolicyConfigSchema,
  parsePolicyConfig,
  hashPolicyConfig,
  DEFAULT_POLICY_CONFIG,
} from './config.js';
export { ELIGIBILITY_RULES, DEFAULT_ELIGIBILITY_RULES_ENABLED } from './eligibility.js';
export type { PolicyEngineOptions } from './engine.js';
export { PolicyEngine } from './engine.js';
