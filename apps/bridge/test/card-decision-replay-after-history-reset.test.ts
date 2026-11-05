// After the bridge keeps a damaged history aside it starts with an empty card ledger and no seen ids, so the relay may hand
// over card decisions it already delivered. None of them may run anything: a signed decision (approve or kill), a native tap
// that was run before the reset, and a native tap that only arrives after it all find no card and refuse. Real bridge, real
// inbound code, real damaged file; the replays are the signed frames the app and the phone made.
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readdirSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ActBodyT,
  type CardT,
  cardNotice,
  createPhoneKeys,
  newUlid,
  noticeSubtitle,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
let b2: Bridge | undefined
afterEach(async () => {
  await b2?.stop()
  b2 = undefined
  await h?.stop()
  h = undefined
})

const PAGE = 4096
function smashRoot(path: string, table: string) {
  const db = new Database(path)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const root = (db.query('SELECT rootpage AS r FROM sqlite_master WHERE name = ?').get(table) as { r: number }).r
  db.close()
  const fd = openSync(path, 'r+')
  writeSync(fd, Buffer.alloc(PAGE, 0xff), 0, PAGE, (root - 1) * PAGE)
  closeSync(fd)
}

async function makeCard(x: Harness): Promise<CardT> {
  const res = await x.bridge.callTool('card', {
    thread_id: 'general',
    kind: 'generic',
    title: 'Archive old drafts',
    summary: 'Moves 12 drafts',
    primary_label: 'Archive',
    kill_label: 'Kill archive',
    risk: 'low',
    origin: 'chat',
    body: 'Folder: Drafts',
  })
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  return (await x.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
}

test('card decisions replayed against the empty ledger of a reset history run nothing', async () => {
  const home = tempHome('talos-hist-replay-')
  h = await startHarness({ home })
  const device = h.app.device
  const keys = await createPhoneKeys()
  const grant = await signNativeGrant({
    deviceId: device.deviceId,
    devicePrivateKey: device.privateKey,
    encPub: keys.encPub,
    actPub: keys.actPub,
    nowMs: Date.now(),
  })
  const nativeTap = async (card: CardT) => {
    const notice = cardNotice(card as never)
    const body = {
      a: 'approve',
      card_id: card.id,
      payload_hash: card.payload_hash,
      shown: shownHash(notice.text, noticeSubtitle(card.thread_id, (h as Harness).bridge.ctx.config.config)),
    } as ActBodyT
    const frame = await signNativeAct({
      deviceId: device.deviceId,
      id: newUlid(),
      ts: new Date().toISOString(),
      grant,
      body,
      actPrivateKey: keys.act.privateKey,
    })
    return { ...frame, relay: { seq: 1, received_at: new Date().toISOString() } }
  }
  // approved and run before the reset
  const approved = await makeCard(h)
  const approve = await h.app.resolveCard(approved, 'primary', approved.payload_hash)
  await h.waitNotes(1)
  const approvedFile = join(home, 'approved', `${approved.id}.json`)
  expect(existsSync(approvedFile)).toBe(true)
  // killed before the reset
  const killed = await makeCard(h)
  const kill = await h.app.resolveCard(killed, 'kill', killed.payload_hash)
  await h.waitNotes(2)
  // a native tap that ran before the reset
  const ran = await makeCard(h)
  const alreadyRun = await nativeTap(ran)
  h.relay.sendToBridge(alreadyRun, { durable: true })
  await h.waitNotes(3)
  await waitFor(() => (h as Harness).bridge.ctx.store.hasSeen(alreadyRun.id as string), 5000, 'the tap to be handled')
  // pending at the reset; their decisions only arrive after it
  const late = await makeCard(h)
  const lateTap = await nativeTap(late)
  const pending = await makeCard(h)
  const pendingResolve = await h.app.sign({
    type: 'card.resolve',
    id: newUlid(),
    v: 1,
    ts: new Date().toISOString(),
    card_id: pending.id,
    action: 'primary',
    payload_hash: pending.payload_hash,
  } as never)
  const approvedBefore = readdirSync(join(home, 'approved')).sort()
  const approvedMtime = statSync(approvedFile).mtimeMs

  // the reset: stop, damage the messages table, start again on the same relay
  await h.bridge.stop()
  Bun.gc(true) // the stopped bridge's database handle must really be gone before its file is damaged and moved
  smashRoot(join(home, 'history.sqlite'), 'messages')
  const env = loadEnv({
    TALOS_APP_HOME: home,
    TALOS_APP_RELAY_URL: h.relay.httpUrl,
    TALOS_APP_BRIDGE: '1',
  })
  b2 = await Bridge.create({ env, logger: nullLogger, inbound: { settleMs: 20, maxSettleMs: 200 } })
  const notes: Array<{ content: string; meta: Record<string, unknown> }> = []
  b2.setEmit(async (n) => {
    notes.push(n as never)
  })
  b2.start()
  await waitFor(() => (b2 as Bridge).client?.connected === true, 10_000, 'the second bridge to connect')
  expect(readdirSync(home).filter((f) => f.startsWith('history.sqlite.corrupt-')).length).toBeGreaterThan(0)
  expect(b2.ctx.ledger.list()).toHaveLength(0)

  const replay = async () => {
    for (const f of [approve, kill, alreadyRun, lateTap, pendingResolve])
      h?.relay.sendToBridge(f as never, { durable: true })
    // a message sent after the replays has been through the pipeline once the agent hears it, so the replays have been judged
    const canary = `canary ${newUlid()}`
    await (h as Harness).app.sendMessage('general', canary)
    await waitFor(() => notes.some((n) => n.content.includes(canary)), 10_000, 'the canary')
  }
  await replay()
  await replay() // and again
  expect(notes.filter((n) => n.meta.kind === 'card_action')).toHaveLength(0)
  expect(b2.ctx.ledger.list()).toHaveLength(0)
  expect(readdirSync(join(home, 'approved')).sort()).toEqual(approvedBefore)
  expect(statSync(approvedFile).mtimeMs).toBe(approvedMtime)
})
