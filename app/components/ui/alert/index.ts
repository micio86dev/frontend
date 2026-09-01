import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Alert } from './Alert.vue'
export { default as AlertAction } from './AlertAction.vue'
export { default as AlertDescription } from './AlertDescription.vue'
export { default as AlertTitle } from './AlertTitle.vue'

export const alertVariants = cva(
  'grid gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*=size-])]:size-4 group/alert relative w-full',
  {
    variants: {
      /**
       * Kept identical to the backoffice's `alertVariants` (DESIGN.md §17 —
       * the two apps' theme layers must not diverge), and for the same reason
       * it changed there: `destructive` recoloured only its TEXT and left the
       * surface identical to `default`, so a failure and a neutral notice were
       * the same card, and success had no colour of its own at all.
       *
       * `NoticeShell.vue` in this app already paired `bg-success-light` with
       * `text-success-dark` — so the tokens were proven here before these
       * variants existed; only this component had not caught up.
       *
       * Light mode uses the text-safe `-dark` foregrounds, never
       * `--color-success` / `--color-warning`, which DESIGN.md §3.1 marks
       * non-text: icons/fills only* and which measure below AA on their own
       * tint. Dark mode inverts the pair: a pale fill on a dark ground is a
       * glare, and the saturated hue is legible there where it was not on
       * pale.
       *
       * No side-stripe accent borders — the reflex decoration for status
       * callouts, which reads as template output.
       */
      variant: {
        default: 'bg-card text-card-foreground',
        success:
          'border-success/35 bg-success-light text-success-dark dark:border-success/30 dark:bg-success/15 dark:text-success *:data-[slot=alert-description]:text-current/90 *:[svg]:text-current',
        warning:
          'border-warning/40 bg-warning-light text-warning-dark dark:border-warning/30 dark:bg-warning/15 dark:text-warning *:data-[slot=alert-description]:text-current/90 *:[svg]:text-current',
        destructive:
          'border-destructive/35 bg-error-light text-destructive dark:border-destructive/30 dark:bg-destructive/15 dark:text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export type AlertVariants = VariantProps<typeof alertVariants>
