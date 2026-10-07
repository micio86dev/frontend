<script lang="ts" setup>
/**
 * shadcn-vue `Sonner` (the `Toaster`), restyled with the project tokens.
 *
 * Every toast is its own opaque white card, like every other surface on the
 * brand canvas (DESIGN.md §7.0.1): it never takes the client colour, so its
 * text keeps a measured contrast whatever colour an operator picked (§9.1,
 * `integrity-toast-contrast.spec.ts`). A warning carries a `--color-error-dark`
 * edge and icon, the text-safe error token.
 *
 * Motion (§10): no transition by default; the slide-in only under
 * `prefers-reduced-motion: no-preference`, 300 ms ease-out, opacity and
 * transform only.
 */
import type { ToasterProps } from 'vue-sonner'
import { Toaster as Sonner } from 'vue-sonner'
import 'vue-sonner/style.css'
import { cn } from '~/lib/utils'

const props = defineProps<ToasterProps>()
</script>

<template>
  <Sonner v-bind="{ ...props, class: cn('toaster', props.class), theme: props.theme ?? 'light' }" />
</template>

<style>
[data-sonner-toaster].toaster[data-sonner-theme] {
  --normal-bg: var(--card);
  --normal-text: var(--card-foreground);
  --normal-border: var(--border);
  --border-radius: var(--radius-lg);
  /* --z-toast (DESIGN.md §3.6): above the interview chrome, below tooltips. */
  z-index: 500;
  font-family: inherit;
}

.toaster [data-sonner-toast][data-styled='true'] {
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.875rem 2.75rem 0.875rem 1rem;
  font-size: 0.875rem;
  box-shadow: var(--shadow-lg);
}

.toaster [data-sonner-toast][data-styled='true'][data-type='warning'] {
  border-inline-start: 4px solid var(--color-error-dark);
}

.toaster [data-sonner-toast][data-styled='true'] [data-icon] {
  margin-top: 0.125rem;
  color: var(--color-error-dark);
}

.toaster [data-sonner-toast][data-styled='true'] [data-title] {
  font-weight: 600;
  color: var(--card-foreground);
}

.toaster [data-sonner-toast][data-styled='true'] [data-description] {
  margin-top: 0.125rem;
  color: var(--card-foreground);
}

/* Inside the card, 28px, not vue-sonner's 20px badge hanging off the corner. */
.toaster [data-sonner-toast][data-styled='true'] [data-close-button] {
  top: 0.5rem;
  right: 0.5rem;
  bottom: auto;
  left: auto;
  width: 1.75rem;
  height: 1.75rem;
  transform: none;
  border: 0;
  background: transparent;
  color: var(--card-foreground);
  cursor: pointer;
}

.toaster [data-sonner-toast][data-styled='true']:hover [data-close-button]:hover {
  border: 0;
  background: var(--color-neutral-100);
}

.toaster [data-sonner-toast][data-styled='true'] [data-close-button]:focus-visible {
  outline: 2px solid var(--card-foreground);
  outline-offset: 2px;
  box-shadow: none;
}

/* §10: no motion unless the candidate's system allows it. */
.toaster [data-sonner-toast],
.toaster [data-sonner-toast] > * {
  transition: none;
}

@media (prefers-reduced-motion: no-preference) {
  .toaster [data-sonner-toast]:not([data-swiping='true']) {
    transition:
      transform 300ms ease-out,
      opacity 300ms ease-out,
      height 300ms ease-out;
  }

  .toaster [data-sonner-toast] > * {
    transition: opacity 300ms ease-out;
  }

  /* Enter from just below its resting place (§10 "slide-in from bottom"), whatever the edge. */
  .toaster [data-sonner-toast][data-mounted='false'] {
    --y: translateY(0.5rem);
  }
}
</style>
