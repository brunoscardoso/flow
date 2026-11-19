/**
 * The built-in browser's session partition — named in ONE place because two
 * processes depend on it agreeing: the renderer gives every `<webview>` this
 * partition, and main installs the `flow-page` scheme handler on the session
 * it names (a `protocol.handle` on the default session does not reach a
 * partition session, and a page load there fails silently with ERR_FAILED —
 * measured in the UI drafts spike, `flow/brain/decisions/ui-drafts-frames.md`).
 *
 * DOM-free and node-free: compiled by both the main and the web tsconfig.
 */
export const FLOW_BROWSER_PARTITION = 'persist:flow-browser'
