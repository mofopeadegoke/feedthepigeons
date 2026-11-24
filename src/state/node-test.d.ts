// The project deliberately has no @types/node; these are just the corners of node's test kit the state tests touch.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    doesNotThrow(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
