/**
 * @aibar/core — zero-dependency kernel (docs/aibar-architecture.md §3–§8).
 * References no DOM APIs (INV-A4); environment access flows through
 * RendererBackend and AIBarHostAdapter.
 *
 * Protocol types are re-exported so hosts can `import { defineItem, asItemIdentifier }`
 * from a single package. `@aibar/protocol` remains the dependency-free surface.
 */
export * from '@aibar/protocol';
export * from './context';
export * from './default-adapter';
export * from './events';
export * from './host-adapter';
export * from './ingress';
export * from './items';
export * from './kernel';
export * from './labels';
export * from './predicate-eval';
export * from './renderer-backend';
export * from './resolver';
