/**
 * cap-protocol — public API surface.
 */

export * from './models/types.js';
export {
  validateResource,
  validateEvent,
  isValidTransition,
  scanForSecrets,
  type ValidationIssue,
  type ValidationResult,
} from './validator/index.js';
export {
  openRegistry,
  initRegistry,
  readResource,
  writeResource,
  listResources,
  appendEvent,
  listEvents,
  listEventsValidated,
  readHead,
  writeHead,
  RegistryParseError,
  type Registry,
} from './utils/registry.js';
export {
  propose,
  assess,
  commit,
  rollback,
  loadProposal,
  listProposals,
  reconstructAt,
  type Proposal,
  type AssessmentReport,
} from './operator/index.js';
