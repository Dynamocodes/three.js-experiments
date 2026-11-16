export const clamp = (x: number, min: number, max: number): number => Math.min(max, Math.max(min, x));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite step from 0 at `edge0` to 1 at `edge1`, like GLSL's smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
