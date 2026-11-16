// Ties the UI-test fixture (ui-test/composer-fixture.html) to what the real app uses, so the fixture cannot stay green while the
// app drifts, and pins ui-test.sh's recovery of capacitor.config.json after a killed run.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const fixture = read('../ui-test/composer-fixture.html')
const nativeTs = read('../../web/src/lib/native.ts')
const toolbar = read('../../web/src/features/composer/ComposerToolbar.tsx')
const attachments = read('../../web/src/features/composer/useComposerAttachments.ts')
const pickerSwift = read('../ios/App/App/Plugins/TalosPicker.swift')

describe('the UI-test fixture matches the real composer and shell', () => {
  it('uses the plugin name and methods native.ts reads and TalosPicker.swift registers', () => {
    // native.ts: Capacitor.Plugins.TalosPicker with pickPhotos / takePhoto / pickFiles; Swift: jsName and the same three methods.
    expect(nativeTs).toContain('Capacitor?: { Plugins?: { TalosPicker?: NativePicker } }')
    expect(pickerSwift).toContain('jsName = "TalosPicker"')
    expect(fixture).toContain('window.Capacitor?.Plugins?.TalosPicker')
    for (const m of ['pickPhotos', 'takePhoto', 'pickFiles']) {
      expect(nativeTs, `native.ts lacks ${m}`).toContain(`${m}: () => Promise<{ files: NativePickedFile[] }>`)
      expect(pickerSwift, `TalosPicker.swift lacks ${m}`).toContain(`CAPPluginMethod(name: "${m}"`)
      expect(fixture, `fixture does not call ${m}`).toContain(`plugin.${m}`)
    }
    // The page's own mapping of menu choice to method, as chooseNative has it.
    expect(attachments).toContain(
      "which === 'photos' ? plugin.pickPhotos : which === 'camera' ? plugin.takePhoto : plugin.pickFiles",
    )
    expect(fixture).toContain(
      "which === 'photos' ? plugin.pickPhotos : which === 'camera' ? plugin.takePhoto : plugin.pickFiles",
    )
  })

  it('has the + button and menu labels ComposerToolbar renders, and the same result shape', () => {
    expect(toolbar).toContain('aria-label="Attach"')
    expect(fixture).toContain('aria-label="Attach"')
    for (const [which, label] of [
      ['photos', 'Photo library'],
      ['camera', 'Camera'],
      ['files', 'Files'],
    ]) {
      expect(toolbar, `ComposerToolbar lacks ${label}`).toContain(`['${which}', `)
      expect(toolbar).toContain(`'${label}'],`)
      expect(fixture).toContain(`data-which="${which}">${label}<`)
    }
    expect(toolbar).toContain('aria-label="Message"')
    expect(fixture).toContain('aria-label="Message"')
    expect(nativeTs).toContain('{ name: string; mime: string; base64: string }')
    expect(pickerSwift).toContain('["name": name, "mime": mime, "base64": data.base64EncodedString()]')
    expect(fixture).toContain('f.base64')
  })
})

describe('ui-test.sh restores capacitor.config.json after a killed run', () => {
  const script = fileURLToPath(new URL('../scripts/ui-test.sh', import.meta.url))
  const run = (cfg: string) =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TALOS_UITEST_CONFIG: cfg,
        TALOS_UITEST_BACKUP_DIR: join(dirname(cfg), 'bak'),
        TALOS_UITEST_RECOVER_ONLY: '1',
        TALOS_UITEST_PORT: '18799',
      },
    })

  it('puts the real config back from the backup a killed run left beside it', () => {
    const cfg = join(mkdtempSync(join(tmpdir(), 'ui-cfg-')), 'capacitor.config.json')
    writeFileSync(cfg, '{"server":{"url": "http://127.0.0.1:18791"}}')
    mkdirSync(join(dirname(cfg), 'bak'), { recursive: true })
    writeFileSync(
      join(dirname(cfg), 'bak', 'capacitor.config.json.orig'),
      '{"server":{"url": "https://relay.example.com"}}',
    )
    const r = run(cfg)
    expect(r.status).toBe(0)
    expect(readFileSync(cfg, 'utf8')).toContain('https://relay.example.com')
    expect(existsSync(join(dirname(cfg), 'bak', 'capacitor.config.json.orig'))).toBe(false)
  })

  it('removes a config the killed run generated when there was none before', () => {
    const cfg = join(mkdtempSync(join(tmpdir(), 'ui-cfg-')), 'capacitor.config.json')
    writeFileSync(cfg, '{"server":{"url": "http://127.0.0.1:18791"}}')
    mkdirSync(join(dirname(cfg), 'bak'), { recursive: true })
    writeFileSync(join(dirname(cfg), 'bak', 'capacitor.config.json.none'), '')
    expect(run(cfg).status).toBe(0)
    expect(existsSync(cfg)).toBe(false)
  })

  it('refuses a fixture-origin config with no backup, saying how to fix it', () => {
    const cfg = join(mkdtempSync(join(tmpdir(), 'ui-cfg-')), 'capacitor.config.json')
    writeFileSync(cfg, '{"server":{"url": "http://127.0.0.1:18791"}}')
    const r = run(cfg)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('cap:sync')
    expect(readFileSync(cfg, 'utf8')).toContain('127.0.0.1')
  })
})
