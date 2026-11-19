// MapLibre rebuilds attribution markup as sources load and change.
export function disableExternalLinks() {
  const selector = 'a[href], area[href]'
  const disable = (link: Element) => {
    const value = link.getAttribute('href')
    if (value === null) return
    const url = URL.parse(value, document.baseURI)
    if (url?.origin === location.origin) return
    link.removeAttribute('href')
  }
  const scan = (element: Element) => {
    if (element.matches(selector)) disable(element)
    element.querySelectorAll(selector).forEach(disable)
  }

  scan(document.documentElement)
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element && record.target.matches(selector)) {
        disable(record.target)
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) scan(node)
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] })
}
