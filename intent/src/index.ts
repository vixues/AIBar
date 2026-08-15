/**
 * @aibar/intent — optional suggestion-lane engines (arch §2.1).
 *
 * Depends on `core` types + `protocol` only; renderers and host business code
 * never appear here. An LLM-backed strategy is a host-injected alternative
 * conforming to the same `predict` contract.
 */
export {
  HeuristicIntentEngine,
  contextKeyOf,
  type IntentEngineOptions,
  type ObservedInvocation,
} from './engine';
