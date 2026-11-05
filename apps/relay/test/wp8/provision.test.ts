// FOLLOWUPS PR9 F9: the Linear/Calendly setup key is used once to register the webhook, then forgotten.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { credsFor } from '../../src/hooks/store.ts'
import { setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

type Call = { url: string; headers: Record<string, string>; body: string }

function vendor(status = 200, json: unknown = { data: { webhookCreate: { success: true } } }) {
  const calls: Call[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') })
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe('one-time webhook provisioning', () => {
  it('Linear: registers the webhook with our signing secret, then deletes the API key', async () => {
    const v = vendor()
    const s = setup({ fetch: v.fetch })
    const conn = await s.create('linear')
    const res = await s.api('POST', `/api/connections/${conn.id}/credentials`, {
      fields: { api_key: `lin_api_${'a'.repeat(24)}`, team_id: 'team-1' },
    })
    expect(await res.json()).toMatchObject({ ok: true })
    expect(v.calls).toHaveLength(1)
    const sent = JSON.parse(v.calls[0]?.body ?? '{}') as { variables: { input: Record<string, string> } }
    expect(sent.variables.input.url).toBe(`${s.f.services.env.PUBLIC_ORIGIN}/hook/linear/${conn.id}`)
    expect(sent.variables.input.secret).toBe(conn.secret)
    expect(sent.variables.input.teamId).toBe('team-1')
    expect(credsFor(s.rt, conn.id).api_key).toBeUndefined()
    // The key is gone from the database in every form.
    const rows = s.f.db.prepare('select * from hooks_connections where id = ?').all(conn.id)
    expect(JSON.stringify(rows)).not.toContain('lin_api_')
    // A later save of plain settings does not ask for the key again, and does not call the vendor again.
    const again = await s.api('POST', `/api/connections/${conn.id}/credentials`, { fields: { user_id: 'u1' } })
    expect(await again.json()).toMatchObject({ ok: true })
    expect(v.calls).toHaveLength(1)
  })

  it('Calendly: signs with our key and forgets the token', async () => {
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(url)
      if (url.endsWith('/users/me'))
        return new Response(JSON.stringify({ resource: { uri: 'u', current_organization: 'o' } }), { status: 200 })
      return new Response('{}', { status: 201 })
    }) as unknown as typeof globalThis.fetch
    const s = setup({ fetch })
    const conn = await s.create('calendly')
    const res = await s.api('POST', `/api/connections/${conn.id}/credentials`, {
      fields: { token: 'tok_secret_value' },
    })
    expect(await res.json()).toMatchObject({ ok: true })
    expect(calls).toHaveLength(2)
    expect(credsFor(s.rt, conn.id).token).toBeUndefined()
  })

  it('a vendor refusal is reported and the key is not kept', async () => {
    const v = vendor(401, {})
    const s = setup({ fetch: v.fetch })
    const conn = await s.create('linear')
    const res = await s.api('POST', `/api/connections/${conn.id}/credentials`, {
      fields: { api_key: `lin_api_${'b'.repeat(24)}` },
    })
    const out = (await res.json()) as { ok: boolean; detail: string }
    expect(out.ok).toBe(false)
    expect(out.detail).toContain('linear_401')
    expect(credsFor(s.rt, conn.id).api_key).toBeUndefined()
  })
})
