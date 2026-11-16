// Handles set in development only, for poking at things from the devtools
// console (e.g. `landscape.aurora.heading = 0.3`, `ambience.wolves()`).
declare global {
  interface Window {
    landscape?: Record<string, unknown>;
    ambience?: unknown;
  }
}

export {};
