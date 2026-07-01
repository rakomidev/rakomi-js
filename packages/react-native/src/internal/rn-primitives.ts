/**
 * Lazy-loaded RN primitive accessor — single internal module that all pre-built
 * components route through. Refactored from per-component `loadRn` so vitest can mock RN primitives at one well-known path
 * (`vi.mock('../src/internal/rn-primitives.js',...)`) without touching component
 * sources.
 *
 * The component test layer relies on this central indirection — production paths
 * are unchanged because Metro/Hermes resolves the real `react-native` package
 * exactly the same way.
 */

type Primitive = any;

interface RnPrimitives {
  View: Primitive;
  Text: Primitive;
  TextInput: Primitive;
  Pressable: Primitive;
}

let cached: RnPrimitives | null = null;

export function loadRnPrimitives(): RnPrimitives {
  if (cached) return cached;
  cached = require('react-native') as any;
  return cached!;
}
