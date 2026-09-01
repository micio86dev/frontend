<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import type { ButtonVariants } from '.'
import { computed } from 'vue'
import { Primitive } from 'reka-ui'
import { cn } from '@/lib/utils'
import { buttonVariants } from '.'

interface Props extends PrimitiveProps {
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  class?: HTMLAttributes['class']
  /**
   * True while the action this button starts is in flight.
   *
   * Renders a spinner, disables the control, and marks it `aria-busy` — the
   * three halves of the same statement, kept together so no call site can ship
   * one without the others. A disabled button with no spinner reads as broken;
   * a spinner on a still-clickable button invites the second submit it exists
   * to prevent; and a purely visual spinner tells a screen-reader user nothing
   * at all.
   *
   * `disabled` is still honoured on its own, for a control that is unavailable
   * rather than working.
   */
  loading?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button',
})

const isDisabled = computed(() => props.disabled === true || props.loading === true)
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :disabled="isDisabled || undefined"
    :aria-busy="loading ? 'true' : undefined"
    :data-loading="loading ? 'true' : undefined"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <!--
      `aria-hidden` and no text: the button keeps its own label while busy
      rather than swapping to "Saving…". Replacing the label moves the control
      under the pointer that is about to click it, and re-announces the button
      to a screen reader as though it were a different one. `aria-busy` above
      is what carries the state.
    -->
    <svg
      v-if="loading"
      data-testid="button-spinner"
      class="size-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
    <slot />
  </Primitive>
</template>
