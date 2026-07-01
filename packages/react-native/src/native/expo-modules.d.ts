/**
 * Ambient module declarations for optional peer-dependencies.
 *
 * These modules are RUNTIME-resolved via dynamic `import()` only when a
 * consumer using the default Expo adapter actually invokes a capability.
 * We deliberately do NOT depend on their @types packages — the local
 * `Expo*Module` interfaces in `expo-adapter.ts` define the shape we use.
 */
declare module 'expo-crypto';
declare module 'expo-secure-store';
declare module 'expo-web-browser';
declare module 'expo-linking';
declare module 'expo-local-authentication';
declare module '@react-native-community/netinfo';
declare module 'react-native';
