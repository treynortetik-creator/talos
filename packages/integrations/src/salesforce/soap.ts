// Salesforce outbound message (SOAP) parsing. Documents with a DOCTYPE or entity declaration are refused outright (no
// XXE, no entity expansion); fast-xml-parser never fetches anything.
import { XMLParser } from 'fast-xml-parser'
import { decodeText } from '../generic/common.ts'

export type SfNotification = { id: string; objectType: string; fields: Record<string, string> }
export type SfMessage = { organizationId: string; notifications: SfNotification[] }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: true,
  parseTagValue: false,
  trimValues: true,
})

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string =>
  typeof v === 'string' ? v : isObj(v) && typeof v['#text'] === 'string' ? v['#text'] : ''

export function parseSoap(bytes: Uint8Array): SfMessage | null {
  const xml = decodeText(bytes)
  if (xml.length > 1_000_000 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml)) return null
  let doc: unknown
  try {
    doc = parser.parse(xml)
  } catch {
    return null
  }
  const env = isObj(doc) ? doc.Envelope : undefined
  const body = isObj(env) ? env.Body : undefined
  const n = isObj(body) ? body.notifications : undefined
  if (!isObj(n)) return null
  const organizationId = text(n.OrganizationId)
  const notifications: SfNotification[] = []
  for (const item of arr(n.Notification)) {
    if (!isObj(item)) continue
    const sobj = item.sObject
    if (!isObj(sobj)) continue
    const type = text(sobj['@_type']).replace(/^.*:/, '')
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(sobj)) {
      if (k.startsWith('@_') || k === 'Id') continue
      const t = text(v)
      if (t) fields[k] = t
    }
    notifications.push({ id: text(item.Id), objectType: type, fields })
  }
  return { organizationId, notifications }
}

/** SOAP reply Salesforce needs to stop retrying. */
export const SOAP_ACK =
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound"><Ack>true</Ack></notificationsResponse></soapenv:Body></soapenv:Envelope>'
