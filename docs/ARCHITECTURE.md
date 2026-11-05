# Architecture

This page is the one-screen version, and the place to start. The code is the final word. The original build spec is not part of this repository. It was kept as history for the reasons behind early decisions, and parts of it are out of date. For a task in
the repo, start at [`AGENTS.md`](../AGENTS.md).

```
 Phone / desktop PWA  ──HTTPS + WSS (passkey session)──▶  Relay (Hono, Node 24, SQLite on a volume)
                                                            ▲   │  /hook/<integration>/<id>  ◀── Slack, GitHub, Gmail script ...
                                                            │   │  /api/voice/session ──▶ voice model (key stays on the relay)
                                      outbound WSS (Ed25519 challenge)
                                                            │   ▼
 Mac: Bridge (Bun, MCP stdio server "talos-app")  ⇄  live Claude Code session (channel notifications in, tools out)
```

## Rules that shape everything

- **The Mac dials out.** Nothing on the Mac is reachable from the internet.
- **The relay keeps no long-term history.** A 7-day encrypted buffer covers offline catch-up; full history lives on the Mac.
- **One Claude Code session serves every thread.** A thread is a `thread_id` tag on each message.
- **The agent controls a computer**, so the relay is treated as a remote-code-execution door: passkey-only login, owner frames
  signed by a device key the Mac pinned, webhook content always delivered as untrusted data.

## Packages

Every folder with a `package.json` is a pnpm workspace package (`pnpm-workspace.yaml`); the Swift app and the Claude Code
plugin are the two parts that are not.

| Path                    | Role                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`     | Frames, models, zod schemas, canonical JSON, signatures, route table. The single source of truth.                   |
| `packages/testkit`      | `FakeRelay`, `FakeBridge`, `FakeApp`, `FakeClaude`, fake clock, fixtures, contract suites.                          |
| `packages/integrations` | Verifiers, normalizers, pollers, setup specs, Apps Script texts. `./catalog` is the browser-safe part.              |
| `apps/relay`            | HTTP + WebSocket server (Hono, Node 24, SQLite). Source folders: `core`, `auth`, `hooks`, `voice`, `session`, `v2`. |
| `apps/web`              | The PWA (React 19, Vite).                                                                                           |
| `apps/bridge`           | The Mac side (Bun): MCP channel server, local history, media, STT/TTS, device pins, the `talos-app` command.        |
| `apps/mobile`           | The iPhone app: a Capacitor shell that loads the web app from the relay.                                            |
| `apps/desktop`          | The Mac menu-bar app (Swift, built with Swift Package Manager, not pnpm). See `docs/desktop.md`.                    |
| `e2e`                   | End-to-end suite: the built relay, the built app and the real bridge together.                                      |
| `plugins/talos-app-mod` | Optional Claude Code plugin that gives the bridge a closer view of the session. See its README.                     |

`protocol`, `testkit` and `integrations` export TypeScript source (`./src/index.ts`, no build step); Vite, esbuild, Vitest
and Bun all consume it.

## Shared contracts

These are the files other packages code against. Change one on purpose, and look at everything that imports it first.

| File                                               | Used for                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/relay/src/env.ts`                            | zod schema of every relay variable                                                                     |
| `apps/relay/src/services.ts`                       | `RelayServices`: db, bus, push, media, crypto, clock, log, env                                         |
| `apps/relay/src/{routes,modules}.ts`               | mounting and registering the relay modules                                                             |
| `apps/relay/src/auth/contract.ts`                  | `requireSession`, `requireCsrf`, `requireStepup`, `verifyBridgeHello`, `verifyBridgeHttp`, `rateLimit` |
| `apps/relay/test/helpers/test-auth.ts`             | the only place `X-Test-Session` exists                                                                 |
| `packages/integrations/src/{types,catalog}.ts`     | `IntegrationModule` and the catalog of integration ids                                                 |
| `apps/web/src/lib/{client,fakeClient,platform}.ts` | `TalosClient`, its in-memory fake, the platform adapter                                                |
| `apps/web/src/features/{contracts,registry}.ts`    | props contracts and lazy entry points for the screens                                                  |
| `apps/web/src/theme/tokens.css`, `src/ui/**`       | the brand and the shadcn-style primitives                                                              |

## Testing

Contract suites in `packages/testkit/src/contract` run against the real relay, bridge and web app.
They are proven satisfiable in this repo by running them against `FakeRelay` and a stub bridge. The relay contract authenticates
exactly like production: session headers and Origin (`RelayHandle.appHeaders`), the relay's own bridge key
(`RelayHandle.bridgeKey`, always enforced), and step-up tokens minted through the harness (`RelayHandle.mintStepup`).
The reasoning behind the test plan is in SPEC.md section 10 (history).
