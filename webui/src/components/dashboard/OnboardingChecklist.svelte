<script>
  // Getting-started checklist on the dashboard (plan epic 2.1; the first-run
  // chain of audit item 8). The steps are read from the data by
  // GET /api/onboarding; the card disappears once the administrator dismisses
  // it and comes back from the «Початок роботи» page, which explains every
  // step in full. Administrators of an organisation only — the superadmin's
  // dashboard is the whole platform, not one organisation.
  import { onMount } from 'svelte'
  import { getOnboarding, dismissOnboarding } from '../../lib/api.js'
  import { t } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'

  let data = null
  let hiding = false

  // Where each step is done. «data» has no page of its own: the controller
  // reports by itself, and this card already sits on the dashboard.
  const LINKS = { site: '#/sites', device: '#/pending', data: null, team: '#/users', responsible: '#/users', notify: '#/notifications', report: '#/reports' }
  const ICONS = { site: 'building', device: 'cpu', data: 'activity', team: 'users', responsible: 'user-check', notify: 'bell', report: 'file-text' }

  onMount(load)

  async function load() {
    try {
      data = await getOnboarding()
    } catch {
      data = null   // the card is a convenience: never an error on the dashboard
    }
  }

  async function hide() {
    hiding = true
    try {
      await dismissOnboarding()
      data = null
    } catch {
      hiding = false
    }
  }

  $: visible = !!data && !data.dismissed_at
  $: trial = data?.trial
  $: trialEnded = trial && trial.status === 'past_due' && trial.trial_expires_at
</script>

{#if visible}
  <section class="onboarding" aria-label={$t('onboarding.title')}>
    <div class="head">
      <div>
        <h2>{$t('onboarding.title')}</h2>
        <p class="sub">
          {data.completed ? $t('onboarding.done_all') : $t('onboarding.subtitle', data.done_count, data.total)}
          {#if trial?.status === 'trial' && trial.days_left !== null}
            · <span class="trial">{$t('onboarding.trial_days_left', trial.days_left)}</span>
          {:else if trialEnded}
            · <a class="trial ended" href="#/billing">{$t('onboarding.trial_ended')}</a>
          {/if}
          · <a class="path" href="#/start">{$t('onboarding.path_link')} →</a>
        </p>
      </div>
      <button type="button" class="dismiss" on:click={hide} disabled={hiding} title={$t('onboarding.dismiss')} aria-label={$t('onboarding.dismiss')}>
        <Icon name="x" size={16} />
      </button>
    </div>

    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax={data.total} aria-valuenow={data.done_count}>
      <span style="width: {Math.round(100 * data.done_count / data.total)}%"></span>
    </div>

    <ol class="steps">
      {#each data.steps as step}
        <li class:done={step.done} class:next={step.key === data.next}>
          <span class="mark"><Icon name={step.done ? 'check' : ICONS[step.key]} size={16} /></span>
          <span class="text">
            <strong>
              {$t('onboarding.step_' + step.key)}
              {#if step.key === data.next}<em class="next-tag">{$t('onboarding.next_step')}</em>{/if}
            </strong>
            <small>{$t('onboarding.step_' + step.key + '_hint')}</small>
            {#if !step.done && LINKS[step.key]}
              <a class="go" href={LINKS[step.key]}>{$t('onboarding.step_' + step.key + '_link')} →</a>
            {/if}
          </span>
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .onboarding {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-5);
  }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .head h2 { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .sub { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--text-muted); }
  .trial { color: var(--accent-blue); }
  .trial.ended { color: var(--accent-orange, #d29922); text-decoration: none; font-weight: 600; }
  .path { color: var(--accent-blue); text-decoration: none; font-weight: 500; }
  .path:hover { text-decoration: underline; }
  .dismiss {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    padding: var(--space-1); border-radius: var(--radius-sm);
  }
  .dismiss:hover { color: var(--text-primary); background: var(--bg-tertiary); }

  .bar { height: 6px; background: var(--bg-tertiary); border-radius: 3px; margin: var(--space-3) 0; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent-green, #3fb950); transition: width 0.3s; }

  .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-2) var(--space-4); }
  .steps li { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2); margin: 0 calc(-1 * var(--space-2)); border-radius: var(--radius-sm); }
  /* The step to take now is the one lit up */
  .steps li.next { background: rgba(74, 158, 255, 0.08); }
  .mark {
    flex: 0 0 auto; width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg-tertiary); color: var(--text-muted);
  }
  li.done .mark { background: rgba(63, 185, 80, 0.15); color: var(--accent-green, #3fb950); }
  li.next .mark { background: rgba(74, 158, 255, 0.15); color: var(--accent-blue); }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .text strong { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  li.done .text strong { color: var(--text-muted); text-decoration: line-through; }
  .next-tag {
    font-style: normal; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent-blue); background: rgba(74, 158, 255, 0.14); padding: 1px 6px; border-radius: var(--radius-full);
  }
  .text small { font-size: var(--text-xs); color: var(--text-muted); line-height: 1.35; }
  .go { align-self: flex-start; font-size: var(--text-xs); font-weight: 600; color: var(--accent-blue); text-decoration: none; white-space: nowrap; padding-top: 4px; }
  .go:hover { text-decoration: underline; }
</style>
