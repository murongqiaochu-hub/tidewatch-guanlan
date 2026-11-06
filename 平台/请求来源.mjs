const INVALID_HEADER = Symbol('invalid-header')
const forbiddenAuthorityChars = /[\p{Cc}\p{Cf}\p{Z}\\,/@?#%]/u

export function resolveOriginMode(originMode, publicOrigin) {
  const selected = originMode ?? (publicOrigin ? 'fixed' : 'auto')
  if (selected !== 'auto' && selected !== 'fixed') throw new TypeError('Origin mode must be auto or fixed')
  return selected
}

function singletonHeader(req, name) {
  const key = name.toLowerCase()
  const distinct = req?.headersDistinct
  if (distinct && Object.hasOwn(distinct, key)) {
    const values = distinct[key]
    return Array.isArray(values) && values.length === 1 ? values[0] : INVALID_HEADER
  }
  if (Array.isArray(req?.rawHeaders)) {
    const values = []
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === key) values.push(req.rawHeaders[i + 1])
    }
    if (values.length > 1) return INVALID_HEADER
    if (values.length === 1) return values[0]
  }
  const headers = req?.headers ?? {}
  const actualKey = Object.keys(headers).find(candidate => candidate.toLowerCase() === key)
  if (actualKey === undefined) return undefined
  const value = headers[actualKey]
  return Array.isArray(value) ? (value.length === 1 ? value[0] : INVALID_HEADER) : value
}

function authorityShape(value) {
  if (typeof value !== 'string' || !value || forbiddenAuthorityChars.test(value)) return false
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close <= 1 || value.lastIndexOf(']') !== close || !value.slice(1, close).includes(':')) return false
    const tail = value.slice(close + 1)
    return tail === '' || /^:\d+$/.test(tail)
  }
  if (value.includes('[') || value.includes(']')) return false
  const firstColon = value.indexOf(':')
  if (firstColon < 0) return true
  return firstColon === value.lastIndexOf(':') && /^\d+$/.test(value.slice(firstColon + 1))
}

function validHostname(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  const domain = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  if (!domain || domain.length > 253) return false
  return domain.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}

function parseAuthority(value, protocol) {
  if (!authorityShape(value)) return null
  try {
    const url = new URL(`${protocol}//${value}`)
    if (url.protocol !== protocol || !url.hostname || !validHostname(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url
  } catch { return null }
}

function parseHttpOrigin(value) {
  if (typeof value !== 'string') return null
  const match = /^(https?):\/\/([^/?#]+)$/i.exec(value)
  if (!match) return null
  const protocol = `${match[1].toLowerCase()}:`
  return parseAuthority(match[2], protocol)
}

// Null means invalid, mismatched or forbidden by a direct TLS socket.
export function matchOriginHost(originValue, hostValue, { encrypted = false } = {}) {
  const origin = parseHttpOrigin(originValue)
  if (!origin || (encrypted && origin.protocol !== 'https:')) return null
  const host = parseAuthority(hostValue, origin.protocol)
  if (!host || host.host !== origin.host) return null
  return { secure: encrypted || origin.protocol === 'https:' }
}

export function createRequestSourcePolicy({ mode, publicOrigin = null, deny, denyCrossSite = deny }) {
  if (mode !== 'auto' && mode !== 'fixed') throw new TypeError('Origin mode must be auto or fixed')
  if (typeof deny !== 'function' || typeof denyCrossSite !== 'function') throw new TypeError('Origin denial factory required')
  const verified = new WeakMap()
  const reject = () => { throw deny() }
  const rejectCrossSite = () => { throw denyCrossSite() }

  function validateHost(req) {
    if (mode !== 'auto') return req.headers?.host
    const host = singletonHeader(req, 'host')
    if (host === INVALID_HEADER || !parseAuthority(host, 'http:')) reject()
    return host
  }

  function assertSameOrigin(req, { opaque = false } = {}) {
    const origin = mode === 'auto' ? singletonHeader(req, 'origin') : req.headers?.origin
    if (origin === INVALID_HEADER) reject()
    const encrypted = req.socket?.encrypted === true
    const fetchSite = mode === 'auto' ? singletonHeader(req, 'sec-fetch-site') : req.headers?.['sec-fetch-site']
    if (fetchSite === INVALID_HEADER) reject()
    if (fetchSite === 'cross-site' && !(opaque && origin === 'null')) rejectCrossSite()

    if (mode === 'fixed') {
      if (origin === undefined) {
        const result = { secure: encrypted }
        verified.set(req, result)
        return result
      }
      if (opaque && origin === 'null') {
        const result = { secure: encrypted }
        verified.set(req, result)
        return result
      }
      let actual, own
      try {
        actual = new URL(origin).origin
        own = new URL('http://' + req.headers.host).origin
      } catch { reject() }
      if (actual !== publicOrigin && actual !== own) reject()
      let publicIsHttps = false
      try { publicIsHttps = new URL(publicOrigin).protocol === 'https:' } catch {}
      const result = { secure: encrypted || (publicIsHttps && origin === new URL(publicOrigin).origin) }
      verified.set(req, result)
      return result
    }

    const host = validateHost(req)
    if (origin === undefined) {
      const result = { secure: encrypted }
      verified.set(req, result)
      return result
    }
    if (opaque && origin === 'null') {
      const result = { secure: encrypted }
      verified.set(req, result)
      return result
    }
    const match = matchOriginHost(origin, host, { encrypted })
    if (!match) reject()
    verified.set(req, match)
    return match
  }

  return Object.freeze({
    validateHost,
    assertSameOrigin,
    isSecureRequest(req) { return req?.socket?.encrypted === true || verified.get(req)?.secure === true }
  })
}
