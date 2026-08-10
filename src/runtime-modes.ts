const modeEnabled = (name: string) =>
  new URLSearchParams(window.location.search).get(name) === 'true'

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

export const noNoiseEnabled = () => modeEnabled('noNoise')

export const runtimeModeUrl = (path: string) => {
  const url = new URL(path, window.location.origin)
  if (adminModeEnabled()) url.searchParams.set('admin', 'true')
  if (diagnosticsModeEnabled()) url.searchParams.set('diagnostics', 'true')
  if (cloudDiagnosticsModeEnabled()) url.searchParams.set('cloudDiagnostics', 'true')
  return `${url.pathname}${url.search}${url.hash}`
}

const toggleModeAndReload = (name: 'admin' | 'diagnostics') => {
  const url = new URL(window.location.href)
  if (url.searchParams.get(name) === 'true') {
    url.searchParams.delete(name)
  } else {
    url.searchParams.set(name, 'true')
  }
  window.location.assign(url.toString())
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
  window.location.assign(url.toString())
}
