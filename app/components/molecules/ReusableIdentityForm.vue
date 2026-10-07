<template>
  <form
    id="reusable-identity"
    novalidate
    data-testid="reusable-identity-form"
    :aria-busy="submitting ? 'true' : undefined"
    class="flex flex-col gap-6"
    @submit.prevent="onSubmit"
  >
    <FieldGroup>
      <Field :data-invalid="errorKey('displayName') ? 'true' : undefined">
        <FieldLabel for="reusable-identity-name">
          {{ $t('interview.reusable.identity.name.label') }}
        </FieldLabel>
        <Input
          id="reusable-identity-name"
          ref="nameInput"
          v-model="displayName"
          name="name"
          autocomplete="name"
          autocapitalize="words"
          required
          aria-required="true"
          :aria-invalid="errorKey('displayName') ? 'true' : undefined"
          :aria-describedby="errorKey('displayName') ? 'reusable-identity-name-error' : undefined"
          @blur="onBlur('displayName')"
        />
        <FieldError v-if="errorKey('displayName')" id="reusable-identity-name-error">
          {{ $t(`interview.reusable.identity.errors.${errorKey('displayName')}`) }}
        </FieldError>
      </Field>

      <Field :data-invalid="errorKey('email') ? 'true' : undefined">
        <FieldLabel for="reusable-identity-email">
          {{ $t('interview.reusable.identity.email.label') }}
        </FieldLabel>
        <Input
          id="reusable-identity-email"
          ref="emailInput"
          v-model="email"
          type="email"
          name="email"
          inputmode="email"
          autocomplete="email"
          autocapitalize="off"
          spellcheck="false"
          required
          aria-required="true"
          :aria-invalid="errorKey('email') ? 'true' : undefined"
          :aria-describedby="errorKey('email') ? 'reusable-identity-email-error' : undefined"
          @blur="onBlur('email')"
        />
        <FieldError v-if="errorKey('email')" id="reusable-identity-email-error">
          {{ $t(`interview.reusable.identity.errors.${errorKey('email')}`) }}
        </FieldError>
      </Field>
    </FieldGroup>

    <!--
      A collection notice, visible text above the button it describes (OD-2): no
      checkbox, no link, no verification step. `aria-describedby` on the button
      points here so the notice is read when the control is reached.
    -->
    <p id="reusable-identity-privacy" class="text-sm text-muted-foreground">
      {{ $t('interview.reusable.identity.privacy') }}
    </p>

    <div>
      <Button
        type="submit"
        size="lg"
        class="h-(--spacing-control) px-6"
        :loading="submitting"
        aria-describedby="reusable-identity-privacy"
        data-testid="reusable-identity-submit"
        @pointerdown="pressingSubmit = true"
        @pointerup="pressingSubmit = false"
        @pointercancel="pressingSubmit = false"
        @pointerleave="pressingSubmit = false"
      >
        {{
          submitting
            ? $t('interview.reusable.identity.submitting')
            : $t('interview.reusable.identity.submit')
        }}
      </Button>
    </div>
  </form>
</template>

<script setup lang="ts">
/**
 * The identity form of the reusable entry route (DESIGN.md §16.19).
 *
 * PRESENTATIONAL, on purpose. It does not know the link token, the candidate
 * session, storage or the API: the page that hosts it owns all of that, and the
 * page is already a security-sensitive state machine. This component validates
 * what the visitor typed, shows the app's OWN localized message for each problem
 * and emits the trimmed values once, when they are valid.
 *
 * Contract worth keeping:
 *
 *   - Validation runs on blur, for the field just left, and on submit for ALL
 *     fields, never short-circuited, so an empty submit flags both at once
 *     (DESIGN §16 rule 3). With any error nothing is emitted and focus moves to
 *     the first invalid field.
 *   - `aria-invalid` and `aria-describedby` are present ONLY while an error is
 *     showing. A reference to an element that does not exist is an axe violation.
 *   - Errors come from two places and are shown the same way: the client checks
 *     (`visitor-identity.ts`) and `serverErrors` (the page maps a 422 or a 409
 *     onto a field). A server error clears as soon as its field is edited. The
 *     server's own message text never reaches this component, only a key.
 *   - There is no `maxlength`: a browser truncates silently, which would store a
 *     different address than the one typed. The limit is a validation message.
 *   - The typed values live in this component's memory and nowhere else: never in
 *     storage, the URL, history, cookies or a log.
 *   - No autofocus on mount. A screen-reader user meets the heading and the intro
 *     first; focus only moves after a failed validation, a 422 or a 409.
 */
import { nextTick, reactive, ref, watch } from 'vue'
import { Button } from '~/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  normalizeIdentityValue,
  validateDisplayName,
  validateEmail,
  type IdentityErrorKey,
} from '~/app/utils/visitor-identity'

type IdentityField = 'displayName' | 'email'
type FieldErrors = Partial<Record<IdentityField, IdentityErrorKey>>

const props = withDefaults(
  defineProps<{
    /** True while the redemption request is in flight: the form cannot be submitted again. */
    submitting: boolean
    /** Errors from the server mapped onto a field by the page (a 422 or a 409). */
    serverErrors?: FieldErrors
    /** Prefill for a re-mount (a retry after a busy or failed state), so nothing is retyped. */
    initialDisplayName?: string
    initialEmail?: string
  }>(),
  { serverErrors: undefined, initialDisplayName: '', initialEmail: '' }
)

const emit = defineEmits<{
  submit: [identity: { displayName: string; email: string }]
}>()

const FIELD_ORDER: readonly IdentityField[] = ['displayName', 'email']

const displayName = ref(props.initialDisplayName)
const email = ref(props.initialEmail)

const nameInput = ref<{ $el: HTMLElement } | null>(null)
const emailInput = ref<{ $el: HTMLElement } | null>(null)

/** The pointer is down on Start (see `onBlur`). */
const pressingSubmit = ref(false)

const clientErrors = reactive<FieldErrors>({})
const serverFieldErrors = reactive<FieldErrors>({})

function validate(field: IdentityField): IdentityErrorKey | null {
  return field === 'displayName'
    ? validateDisplayName(displayName.value)
    : validateEmail(email.value)
}

/** The error to show for a field: the server's word wins over a stale client check. */
function errorKey(field: IdentityField): IdentityErrorKey | undefined {
  return serverFieldErrors[field] ?? clientErrors[field]
}

function focusField(field: IdentityField): void {
  const target = field === 'displayName' ? nameInput.value : emailInput.value
  target?.$el?.focus()
}

function setClientError(field: IdentityField, key: IdentityErrorKey | null): void {
  clientErrors[field] = key ?? undefined
}

/**
 * A blur caused by pressing Start is left to the submit. Validating there would
 * insert the error ABOVE the button between pointerdown and pointerup, the
 * button would move, and the click would land elsewhere: Start pressed,
 * nothing happens. `onSubmit` validates every field and focuses the first
 * invalid one. Keyed on the POINTER, not on where focus went: a keyboard user
 * tabbing to Start still gets the field checked on the way, and in WebKit a
 * pressed button does not take focus at all, so `relatedTarget` would miss it.
 */
function onBlur(field: IdentityField): void {
  if (pressingSubmit.value) return

  setClientError(field, validate(field))
}

/**
 * Editing a field answers its server error (the visitor is fixing what the server
 * refused), and re-checks a field that already shows a client error so the message
 * goes away the moment the value is good, not only on the next blur.
 */
function onEdit(field: IdentityField): void {
  serverFieldErrors[field] = undefined
  if (clientErrors[field] !== undefined) setClientError(field, validate(field))
}

watch(displayName, () => onEdit('displayName'))
watch(email, () => onEdit('email'))

watch(
  () => props.serverErrors,
  (incoming) => {
    for (const field of FIELD_ORDER) serverFieldErrors[field] = undefined
    Object.assign(serverFieldErrors, incoming ?? {})
    const first = FIELD_ORDER.find((field) => serverFieldErrors[field] !== undefined)
    if (first) void nextTick(() => focusField(first))
  },
  { immediate: true }
)

function onSubmit(): void {
  if (props.submitting) return

  // Every field is validated, never `a && b`: an empty submit flags both at once.
  for (const field of FIELD_ORDER) setClientError(field, validate(field))

  const firstInvalid = FIELD_ORDER.find((field) => clientErrors[field] !== undefined)
  if (firstInvalid) {
    focusField(firstInvalid)
    return
  }

  emit('submit', {
    displayName: normalizeIdentityValue(displayName.value),
    email: normalizeIdentityValue(email.value),
  })
}
</script>
