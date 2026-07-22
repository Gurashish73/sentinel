/**
 * Test-only shim. 
 * 
 * The real "server-only" package throws when imported outside Next's 
 * "react-server" bundler condition, which Vitest doesn't set. This empty 
 * stub lets files with `import "server-only"` load under Vitest without 
 * pulling in the whole Next.js runtime.
 */