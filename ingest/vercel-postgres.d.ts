/**
 * The shape of `@vercel/postgres` this function uses — nothing more.
 *
 * Declared here rather than installed, so the repo's typecheck and tests run
 * without pulling a dependency that only the DEPLOYED function needs. Vercel
 * installs the real package from `package.json` at build time.
 *
 * The trade, stated: this declaration can drift from the real package. It
 * covers one tagged-template function and the two fields read off its result,
 * so the surface that can drift is about as small as a surface gets — and the
 * alternative is a `node_modules` in this folder that nothing local uses.
 */
declare module '@vercel/postgres' {
  export interface QueryResult<T = Record<string, unknown>> {
    rows: T[]
    rowCount: number | null
  }
  export function sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<QueryResult<T>>
}
