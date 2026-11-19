import { modeEnabled as queryModeEnabled } from './atlas-protocol'
import { disableExternalLinks } from './external-links'

const noLinkOut = new URLSearchParams(location.search).get('noLinkOut')
if (noLinkOut === '' || noLinkOut === 'true') disableExternalLinks()

const modeEnabled = (name: string) =>
  queryModeEnabled(new URLSearchParams(window.location.search), name)

export const revealedModeEnabled = () => modeEnabled('revealed')

export const reviewModeEnabled = () => modeEnabled('review')

export const adminModeEnabled = () => modeEnabled('admin')

export const diagnosticsModeEnabled = () => modeEnabled('diagnostics')

// Cloud eligibility is an admin-only diagnostic and is enabled by default for
// cache administration. Pass cloudDiagnostics=false to hide it temporarily.
export const cloudDiagnosticsModeEnabled = () =>
  adminModeEnabled() &&
  new URLSearchParams(window.location.search).get('cloudDiagnostics') !== 'false'

export const noSplashEnabled = () => modeEnabled('noSplash')

export const kioskModeEnabled = () => modeEnabled('kioskMode')

export const noMusicEnabled = () =>
  new URLSearchParams(window.location.search).has('noMusic')

export const noFakeRenderEnabled = () => modeEnabled('noFakeRender') || modeEnabled('no-fake-render')

export const noNoiseEnabled = () => modeEnabled('noNoise')

// URLSearchParams adds '=' to empty values. Keep map mode links bare.
export const mapModePath = (url: URL) => {
  const search = url.search.replace(/(^\?|&)(admin|diagnostics|review|revealed)=(?:true)?(?=&|$)/g, '$1$2')
  return url.pathname + search + url.hash
}

export const runtimeModeUrl = (path: string) => {
  const url = new URL(path, window.location.origin)
  if (adminModeEnabled() || url.searchParams.get('admin') === '')
    url.searchParams.set('admin', 'true')
  if (diagnosticsModeEnabled() || url.searchParams.get('diagnostics') === '')
    url.searchParams.set('diagnostics', 'true')
  if (cloudDiagnosticsModeEnabled()) url.searchParams.set('cloudDiagnostics', 'true')
  return url.pathname + url.search + url.hash
}

const toggleModeAndReload = (name: 'admin' | 'diagnostics') => {
  const url = new URL(window.location.href)
  if (queryModeEnabled(url.searchParams, name)) {
    url.searchParams.delete(name)
  } else {
    for (const flag of ['admin', 'diagnostics', 'review', 'revealed']) url.searchParams.delete(flag)
    url.searchParams.set(name, '')
  }
  window.location.assign(mapModePath(url))
}

declare global {
  interface Window {
    toggle_auth: () => void
    toggle_diagnostics: () => void
    toggle_cloud_diagnostics: () => void
  }
}

window.toggle_auth = () => toggleModeAndReload('admin')
window.toggle_diagnostics = () => toggleModeAndReload('diagnostics')
window.toggle_cloud_diagnostics = () => {
  const url = new URL(window.location.href)
  url.searchParams.set(
    'cloudDiagnostics',
    cloudDiagnosticsModeEnabled() ? 'false' : 'true',
  )
  window.location.assign(mapModePath(url))
}
