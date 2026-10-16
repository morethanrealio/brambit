// Types for test-support/chromium.mjs (used by the TypeScript browser tests).
export declare function chromiumPath(env?: NodeJS.ProcessEnv): string | null;
export declare function chromiumSkipReason(env?: NodeJS.ProcessEnv): string | false;
export declare function browserAvailableOrSkip(name: string): boolean;
