/* eslint-disable no-unused-vars */
/**
 * Tavus provider implementation using Daily.co.
 *
 * SSR INVARIANT (D2, CRITICAL):
 * The @daily-co/daily-js module references browser globals at import evaluation time.
 * It MUST NEVER be imported at module scope — only via dynamic `await import()`
 * inside a function guarded by `import.meta.client`.
 *
 * Completion detection: Tavus signals end of interview via a structured `app-message`
 * event (Daily.co) with `data.type = 'conversation.tool_call'` and `data.name = 'end_interview'`.
 * Unlike HeyGen, Tavus does NOT use phrase matching — endPhrase/finalPhrase in StartConfig
 * are accepted but not validated or used for completion detection.
 */

import type {
  InterviewProvider,
  ProviderEvent,
  ProviderState,
  StartConfig,
} from '~/app/types/interview-provider'

// Minimal Daily.co call frame shape used by this provider
interface DailyCallFrame {
  on(event: string, handler: (data: Record<string, unknown>) => void): void
  join(opts: Record<string, unknown>): Promise<void>
  leave(): Promise<void>
  destroy(): Promise<void>
}

type EventCallback = (payload: unknown) => void

/**
 * Tavus provider (Daily.co).
 *
 * Completion detection: listens for Daily.co `app-message` events where
 * `data.type === 'conversation.tool_call'` and `data.name === 'end_interview'`.
 *
 * No phrase-matching: endPhrase and finalPhrase from StartConfig are not used
 * (Tavus handles turn-taking server-side via tool calls).
 *
 * @param sdkLoader - Injectable Daily.co frame factory for testability.
 *   Production default: dynamically imports Daily.co under import.meta.client guard.
 */
export class TavusProvider implements InterviewProvider {
  private readonly listeners = new Map<ProviderEvent, EventCallback[]>()
  private callFrame: DailyCallFrame | null = null

  private readonly sdkLoader: (
    conversationUrl: string,
    mountEl: HTMLElement
  ) => Promise<DailyCallFrame>

  constructor(
    sdkLoader?: (conversationUrl: string, mountEl: HTMLElement) => Promise<DailyCallFrame>
  ) {
    if (sdkLoader) {
      this.sdkLoader = sdkLoader
    } else {
      // Production path: dynamic import guarded by import.meta.client
      this.sdkLoader = async (
        conversationUrl: string,
        mountEl: HTMLElement
      ): Promise<DailyCallFrame> => {
        if (!import.meta.client) {
          throw new Error('TavusProvider: SDK must only be loaded in a client-side context.')
        }
        const Daily = await import('@daily-co/daily-js')
        const frame = Daily.default.createFrame(mountEl, {
          iframeStyle: { width: '100%', height: '100%', border: 'none' },
          showLeaveButton: false,
          showFullscreenButton: false,
        })
        return frame as unknown as DailyCallFrame
      }
    }
  }

  on(evt: ProviderEvent, cb: EventCallback): void {
    const existing = this.listeners.get(evt) ?? []
    this.listeners.set(evt, [...existing, cb])
  }

  private emit(evt: ProviderEvent, payload: unknown): void {
    for (const cb of this.listeners.get(evt) ?? []) {
      cb(payload)
    }
  }

  private emitState(state: ProviderState): void {
    this.emit('state', state)
  }

  async start(mountEl: HTMLElement, cfg: StartConfig): Promise<{ providerSessionId?: string }> {
    this.emitState('connecting')

    try {
      // Load the Daily.co call frame (real SDK or injected mock)
      this.callFrame = await this.sdkLoader(cfg.conversationUrl ?? '', mountEl)

      // Wire event handlers

      // Participant joined / meeting state
      this.callFrame.on('joined-meeting', () => {
        this.emitState('ready')
      })

      // Completion detection: Tavus sends end_interview via tool call
      this.callFrame.on('app-message', (event) => {
        const data = event?.data as Record<string, unknown> | undefined
        if (data?.type === 'conversation.tool_call' && data?.name === 'end_interview') {
          this.emitState('complete')
        }
      })

      // Join the Tavus conversation room
      await this.callFrame.join({ url: cfg.conversationUrl ?? '' })

      // Note: 'ready' is emitted via the 'joined-meeting' event above.
      // If the event hasn't fired before join() resolves, emit it here as a fallback.
      if (!this.emittedReady) {
        this.emittedReady = true
        this.emitState('ready')
      }

      return {}
    } catch (err) {
      this.emit('error', { code: 'sdk_error', message: String(err) })
      return {}
    }
  }

  // Track whether 'ready' was already emitted (from joined-meeting event)
  private emittedReady = false

  async toggleMic(): Promise<void> {
    // Daily.co mic toggle is typically handled via setLocalAudio() or similar.
    // This is a no-op placeholder in the base provider — the AvatarPlayer
    // component manages Daily.co mic state through the frame reference.
  }

  async stop(): Promise<void> {
    if (this.callFrame) {
      try {
        await this.callFrame.leave()
      } catch {
        // stop() errors are non-fatal — log and suppress (D3)
      }
    }
    this.emitState('stopped')
  }
}
