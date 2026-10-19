// Type declarations for sdk-platform.mjs — the module itself is plain JS so
// the uncompiled packaging scripts can import it; this file is what lets the
// TypeScript main process import the SAME module with full type checking
// instead of keeping its own copy.

/** The SDK's native package for a platform/arch, or null when none is published. */
export declare function sdkPackageName(
  platform: NodeJS.Platform | string,
  arch: string,
): string | null

/** The executable's file name inside that package (`claude` vs `claude.exe`). */
export declare function sdkBinaryName(platform: NodeJS.Platform | string): string

/** `<package>/<binary>` specifier for require.resolve, or null when unsupported. */
export declare function sdkBinarySpecifier(
  platform: NodeJS.Platform | string,
  arch: string,
): string | null

/** Smallest size a real native binary can have — below it is a stub/truncation. */
export declare const SDK_BINARY_MIN_BYTES: number
