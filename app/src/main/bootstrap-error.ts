// User-facing copy for a FATAL bootstrap failure (#163). The app can't run
// without its store, so it quits — but it must first tell the user WHY (a
// silent quit reads as "the app is just broken"). Pure so the message mapping
// is unit-testable without Electron's dialog.

export interface BootstrapErrorDialog {
  title: string
  message: string
}

/**
 * Map a fatal bootstrap error to a title + message for `dialog.showErrorBox`.
 * Special-cases the "schema newer than this app" downgrade guard (a distinct,
 * actionable cause: update the app); everything else is treated as an
 * open/corrupt/disk failure with the raw detail attached.
 */
export function describeBootstrapError(error: unknown): BootstrapErrorDialog {
  const detail = error instanceof Error ? error.message : String(error)
  if (/newer than this app supports/i.test(detail)) {
    return {
      title: "Flow can't open your data",
      message:
        'Your Flow data was created by a newer version of the app, so this ' +
        'version can’t open it safely.\n\nPlease update Flow to the latest ' +
        'version, then reopen.',
    }
  }
  return {
    title: "Flow can't open your data",
    message:
      'Flow could not open its database. It may be corrupt or locked by another ' +
      'process, or the disk may be full.\n\n' +
      `Details: ${detail}`,
  }
}
