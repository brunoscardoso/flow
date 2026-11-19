// connector-icon-assets — the icons Flow ships for well-known services
// (plan_connectors, Phase 3, note 6). Step two of the icon order: used when the
// server declared no icon of its own (or it could not be fetched).
//
// They are inline strings rather than files under `resources/` because a
// `resources/` folder is only reachable in a packaged build through an
// `extraResources` entry, while a module is bundled into main the same way in
// dev and in the packaged app. They are simple marks drawn for Flow — a brand
// colour and a shape — not copies of the services' artwork.
//
// A monochrome mark needs a colour per theme: an <img> does not inherit
// `currentColor`, so `ink` is filled in for the theme asked.

import type { ConnectorIconTheme } from '../../shared/connectors'

export interface ShippedIcon {
  /** A word of the server's name that names the service (`linear`, `github`). */
  names: readonly string[]
  /** Hosts the service's connectors live on; a sub-host matches too. */
  hosts: readonly string[]
  /** The SVG, given the ink colour for the theme. */
  svg: (ink: string) => string
}

const svg = (body: string, viewBox = '0 0 24 24'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`

const GITHUB_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'

export const SHIPPED_ICONS: readonly ShippedIcon[] = [
  {
    names: ['linear'],
    hosts: ['linear.app'],
    svg: () =>
      svg(
        '<rect width="24" height="24" rx="6" fill="#5E6AD2"/>' +
          '<path d="M5 13.5 10.5 19M5 10l9 9M6.5 7l10.5 10.5M9.5 5.3 18.7 14.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
      ),
  },
  {
    names: ['github'],
    hosts: ['github.com', 'githubcopilot.com', 'githubusercontent.com'],
    svg: (ink) => svg(`<path fill="${ink}" d="${GITHUB_PATH}"/>`, '0 0 16 16'),
  },
  {
    names: ['sentry'],
    hosts: ['sentry.io', 'sentry.dev'],
    svg: () =>
      svg(
        '<rect width="24" height="24" rx="6" fill="#362D59"/>' +
          '<path d="M4.5 18h3.2a6 6 0 0 0-3-5.2M8 18h3.5A9.5 9.5 0 0 0 7 9.8L12 4l7.5 14h-4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>',
      ),
  },
  {
    names: ['notion'],
    hosts: ['notion.com', 'notion.so'],
    svg: (ink) =>
      svg(
        `<rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="${ink}" stroke-width="1.8"/>` +
          `<path d="M8.5 16.5v-9l7 9v-9" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`,
      ),
  },
  {
    names: ['neon'],
    hosts: ['neon.tech', 'neon.com'],
    svg: () =>
      svg(
        '<rect width="24" height="24" rx="6" fill="#00E599"/>' +
          '<path d="M7 18V6l10 10.5V6" fill="none" stroke="#0B0D0C" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
      ),
  },
  {
    names: ['vercel'],
    hosts: ['vercel.com', 'vercel.app'],
    svg: (ink) => svg(`<path fill="${ink}" d="M12 3 22.5 21h-21z"/>`),
  },
  {
    names: ['slack'],
    hosts: ['slack.com'],
    svg: () =>
      svg(
        '<rect x="9.5" y="2" width="3.5" height="10" rx="1.75" fill="#36C5F0"/>' +
          '<rect x="12" y="9.5" width="10" height="3.5" rx="1.75" fill="#2EB67D"/>' +
          '<rect x="11" y="12" width="3.5" height="10" rx="1.75" fill="#ECB22E"/>' +
          '<rect x="2" y="11" width="10" height="3.5" rx="1.75" fill="#E01E5A"/>',
      ),
  },
  {
    names: ['atlassian', 'jira', 'confluence'],
    hosts: ['atlassian.com', 'atlassian.net'],
    svg: () =>
      svg(
        '<path fill="#0052CC" d="M7.2 11.3c-.3-.4-.9-.4-1.1.1L2 19.6c-.2.4.1.9.6.9h5.8c.3 0 .5-.2.6-.4 1.2-2.6.5-6.5-1.8-8.8z"/>' +
          '<path fill="#2684FF" d="M11.7 3.7c-2.1 3.3-2 7 .2 11.4l2.8 5c.1.2.3.4.6.4h5.8c.5 0 .8-.5.6-.9L12.8 3.7c-.2-.5-.9-.5-1.1 0z"/>',
      ),
  },
  {
    names: ['figma'],
    hosts: ['figma.com'],
    svg: () =>
      svg(
        '<path fill="#F24E1E" d="M8.5 2h3.5v6.5H8.5a3.25 3.25 0 0 1 0-6.5z"/>' +
          '<path fill="#FF7262" d="M12 2h3.5a3.25 3.25 0 0 1 0 6.5H12z"/>' +
          '<path fill="#A259FF" d="M8.5 8.5H12V15H8.5a3.25 3.25 0 0 1 0-6.5z"/>' +
          '<circle fill="#1ABCFE" cx="15.5" cy="11.75" r="3.25"/>' +
          '<path fill="#0ACF83" d="M8.5 15H12v3.25A3.25 3.25 0 1 1 8.5 15z"/>',
      ),
  },
  {
    names: ['stripe'],
    hosts: ['stripe.com'],
    svg: () =>
      svg(
        '<rect width="24" height="24" rx="6" fill="#635BFF"/>' +
          '<path d="M15.5 8.6c-.9-.6-2.1-1-3.3-1-1.8 0-3 .9-3 2.2 0 3.2 6.6 2 6.6 5.3 0 1.5-1.4 2.4-3.4 2.4-1.4 0-2.8-.5-3.8-1.2" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>',
      ),
  },
]

/** The ink a monochrome mark is drawn in, for the theme it sits on. */
export function inkFor(theme: ConnectorIconTheme): string {
  return theme === 'dark' ? '#F2F2F2' : '#1A1A1A'
}
