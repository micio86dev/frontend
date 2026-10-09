<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button
        data-testid="call-exit"
        variant="outline"
        class="h-(--spacing-control) px-5"
        :loading="loading"
      >
        {{ $t('interview.call.exit.label') }}
      </Button>
    </DialogTrigger>

    <DialogContent :show-close-button="false">
      <DialogHeader>
        <DialogTitle>{{ $t('interview.call.exit.title') }}</DialogTitle>
        <DialogDescription>
          {{
            deadline
              ? $t('interview.call.exit.body', { time: deadline })
              : $t('interview.call.exit.body_no_deadline')
          }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose as-child>
          <Button data-testid="call-exit-stay" variant="outline" class="h-(--spacing-control)">
            {{ $t('interview.call.exit.cancel') }}
          </Button>
        </DialogClose>
        <Button data-testid="call-exit-confirm" class="h-(--spacing-control)" @click="onConfirm">
          {{ $t('interview.call.exit.confirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * CallExitDialog — the call screen's Exit button and its confirmation
 * (candidate-interview-call-ui D9; DESIGN.md §7.3, §9).
 *
 * The label says "Exit" and the action tears down a live conversation, so a
 * click opens a confirmation first. The dialog traps focus, closes on Escape or
 * "Stay", and hands focus back to the button (reka-ui's trigger does that; the
 * button is the `DialogTrigger`).
 *
 * Props:
 *   loading — a competency handover is in flight. The button is disabled and
 *             shows its spinner, never hidden (`Button`'s `loading` does both).
 *
 * Emits:
 *   confirm — once, when the candidate chooses "Suspend and leave". The parent
 *             suspends the interview; this component knows nothing of sessions.
 *
 * The deadline is the stored session's `exp`, read each time the dialog opens
 * through `useCandidateSession().read()` (the only sanctioned reader) and
 * formatted in the ACTIVE locale. When the session cannot be read the sentence
 * is dropped, not guessed: the `body_no_deadline` copy carries the rest.
 */
import { ref, computed } from 'vue'
import { useCandidateSession } from '~/composables/useCandidateSession'
import { formatDeadline } from '~/utils/call-deadline'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'

defineProps<{
  loading?: boolean
}>()

const emit = defineEmits<{
  confirm: []
}>()

const { locale } = useI18n()
const candidateSession = useCandidateSession()

const open = ref(false)

/** Recomputed on each open so the time is never older than the click that asked for it. */
const deadline = computed(() =>
  open.value ? formatDeadline(candidateSession.read()?.exp, locale.value) : null
)

function onConfirm(): void {
  open.value = false
  emit('confirm')
}
</script>
