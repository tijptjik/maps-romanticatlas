const modeEnabled = (name: string) =>
  new URLSearchParams(window.location.search).get(name) === 'true'

export const adminModeEnabled = () => modeEnabled('admin')

export const diagnosticsModeEnabled = () => modeEnabled('diagnostics')

export const noSplashEnabled = () => modeEnabled('noSplash')

export const noMusicEnabled = () => new URLSearchParams(window.location.search).has('noMusic')

export const runtimeModeUrl = (path: string) => {
  const url = new URL(path, window.location.origin)
  if (adminModeEnabled()) url.searchParams.set('admin', 'true')
  if (diagnosticsModeEnabled()) url.searchParams.set('diagnostics', 'true')
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
  }
}

window.toggle_auth = () => toggleModeAndReload('admin')
window.toggle_diagnostics = () => toggleModeAndReload('diagnostics')
