export declare const PUBLIC_BUILD_KEYS: ReadonlyArray<readonly [string, string]>
export declare const SECRET_BUILD_KEYS: ReadonlyArray<readonly [string, string]>
export declare const ALL_BUILD_KEYS: ReadonlyArray<readonly [string, string]>
export declare const PUBLIC_CONFIG_FILE: string
export declare const LOCAL_SECRETS_FILE: string
export declare function publicBuildConfig(appDir: string, env?: NodeJS.ProcessEnv): Record<string, string>
export declare function distributableBuildConfig(
  appDir: string,
  env?: NodeJS.ProcessEnv,
): { values: Record<string, string>; missing: Array<readonly [string, string]>; problems: string[] }
