// The tests run in Node; the project has no @types/node, only this one function is used.
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}
