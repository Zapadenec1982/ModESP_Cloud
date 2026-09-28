<script>
  // «Початок роботи» (audit item 8): the one page that says what the signed-in
  // role sees and where to begin, and — for an organisation's administrator —
  // the whole first-run chain: what each step needs, where it is done and how
  // the platform tells it is done. It renders the same checklist the
  // dashboard card shows (GET /api/onboarding), not a copy of it, and brings
  // the card back once it was dismissed.
  import { onMount } from 'svelte'
  import { getOnboarding, restoreOnboarding, getSupportInfo } from '../lib/api.js'
  import { authUser, authEnabled, isAdmin, isSuperAdmin, isPartner } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import { formatDate } from '../lib/format.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'

  // Where each step of the chain is done
  const LINKS = { site: '#/sites', device: '#/pending', data: '#/', team: '#/users', responsible: '#/users', notify: '#/notifications', report: '#/reports' }
  const ICONS = { site: 'building', device: 'cpu', data: 'activity', team: 'users', responsible: 'user-check', notify: 'bell', report: 'file-text' }

  // What each role starts with: the bullets are start.role_<role>_1…N, each a
  // link to the page it talks about
  const GUIDE = {
    admin:      { icon: 'settings', links: ['#/', '#/sites', '#/work-orders', '#/users'] },
    technician: { icon: 'wrench',   links: ['#/', '#/alarms', '#/map', '#/notifications'] },
    viewer:     { icon: 'grid',     links: ['#/', '#/reports', '#/notifications'] },
    superadmin: { icon: 'globe',    links: ['#/', '#/tenants', '#/admin/billing', '#/firmware'] },
  }

  // With auth off there is no user: the page reads as an administrator's
  $: role = $authEnabled ? ($authUser?.role || 'viewer') : 'admin'
  $: guide = GUIDE[role] || GUIDE.viewer
  // The chain belongs to the organisation's administrator; the superadmin's
  // dashboard is the platform, and the checklist of their own organisation
  // would say nothing useful
  $: showPath = $isAdmin && !$isSuperAdmin

  let data = null
  let info = null
  let loading = true
  let restoring = false

  onMount(async () => {
    const [ob, si] = await Promise.allSettled([showPath ? getOnboarding() : Promise.resolve(null), getSupportInfo()])
    if (ob.status === 'fulfilled') data = ob.value
    if (si.status === 'fulfilled') info = si.value
    loading = false
  })

  async function restore() {
    restoring = true
    try {
      data = await restoreOnboarding()
      toast.success($t('start.card_shown'))
    } catch (err) {
      toast.error(err.message)
    } finally {
      restoring = false
    }
  }

  function stateOf(step) {
    if (step.done) return step.done_at ? $t('start.done_at', formatDate(step.done_at)) : $t('start.status_done')
    return step.key === data.next ? $t('start.status_next') : $t('start.status_todo')
  }
</script>

<div class="start-page">
  <PageHeader title={$t('pages.start')} subtitle={$t('pages.start_sub')} />

  <!-- What this role sees and where to begin -->
  <section class="card">
    <div class="role-head">
      <span class="role-icon"><Icon name={guide.icon} size={20} /></span>
      <div>
        <h2>{$t('start.role_title', $t('users.role_' + role))}</h2>
        <p class="muted">{$t('start.role_' + role + '_intro')}</p>
      </div>
    </div>
    <ol class="guide">
      {#each guide.links as href, i}
        <li>
          <a class="guide-link" {href}>
            <span class="guide-num">{i + 1}</span>
            <span>{$t('start.role_' + role + '_' + (i + 1))}</span>
            <Icon name="chevron-right" size={16} />
          </a>
        </li>
      {/each}
      {#if $isPartner && role === 'admin'}
        <li>
          <a class="guide-link" href="#/partner">
            <span class="guide-num"><Icon name="link" size={12} /></span>
            <span>{$t('start.role_partner')}</span>
            <Icon name="chevron-right" size={16} />
          </a>
        </li>
      {/if}
    </ol>
    {#if !showPath && role !== 'superadmin'}
      <p class="muted note"><Icon name="info" size={14} /> {$t('start.ask_admin')}</p>
    {/if}
  </section>

  <!-- The first-run chain (administrators of an organisation) -->
  {#if showPath}
    <section class="card" aria-labelledby="path-title">
      <div class="path-head">
        <div>
          <h2 id="path-title">{$t('start.path_title')}</h2>
          <p class="muted">{$t('start.path_intro')}</p>
        </div>
        {#if data}
          <div class="progress">
            <span class="progress-text">{data.completed ? $t('onboarding.done_all') : $t('start.progress', data.done_count, data.total)}</span>
            <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax={data.total} aria-valuenow={data.done_count}>
              <span style="width: {Math.round(100 * data.done_count / data.total)}%"></span>
            </div>
            {#if data.trial?.status === 'trial' && data.trial.days_left !== null}
              <span class="trial">{$t('onboarding.trial_days_left', data.trial.days_left)}</span>
            {:else if data.trial?.status === 'past_due' && data.trial.trial_expires_at}
              <a class="trial ended" href="#/billing">{$t('onboarding.trial_ended')}</a>
            {/if}
          </div>
        {/if}
      </div>

      {#if loading}
        <Skeleton height="240px" />
      {:else if data}
        <ol class="steps">
          {#each data.steps as step, i (step.key)}
            <li class:done={step.done} class:next={step.key === data.next}>
              <span class="num">{#if step.done}<Icon name="check" size={16} />{:else}{i + 1}{/if}</span>
              <div class="step-body">
                <div class="step-title">
                  <Icon name={ICONS[step.key]} size={16} />
                  <strong>{$t('onboarding.step_' + step.key)}</strong>
                  <span class="state">{stateOf(step)}</span>
                </div>
                <p class="how">{$t('onboarding.step_' + step.key + '_how')}</p>
                <p class="when muted">{$t('start.done_when', $t('onboarding.step_' + step.key + '_done'))}</p>
                {#if !step.done}
                  <a class="go" href={LINKS[step.key]}>{$t('onboarding.step_' + step.key + '_link')} →</a>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
        {#if data.dismissed_at}
          <div class="card-row">
            <span class="muted">{$t('start.card_hidden')}</span>
            <Button variant="secondary" size="sm" loading={restoring} on:click={restore}>{$t('start.card_show')}</Button>
          </div>
        {/if}
      {/if}
    </section>
  {/if}

  <!-- Where to go from here -->
  <section class="card">
    <h2>{$t('start.more_title')}</h2>
    <div class="more">
      <a class="more-link" href="#/support"><Icon name="help-circle" size={16} /> {$t('start.more_support')}</a>
      {#if info?.docs_url}
        <a class="more-link" href={info.docs_url} target="_blank" rel="noopener"><Icon name="file-text" size={16} /> {$t('start.more_docs')}</a>
      {/if}
      <a class="more-link" href="#/notifications"><Icon name="bell" size={16} /> {$t('start.more_notifications')}</a>
      <a class="more-link" href="#/security"><Icon name="shield" size={16} /> {$t('start.more_security')}</a>
    </div>
  </section>
</div>

<style>
  .start-page { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-4); }
  .card {
    background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5); display: flex; flex-direction: column; gap: var(--space-3);
  }
  .card h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--text-primary); }
  .muted { margin: 0; color: var(--text-muted); font-size: var(--text-sm); line-height: 1.5; }

  /* role */
  .role-head { display: flex; align-items: flex-start; gap: var(--space-3); }
  .role-icon {
    flex: 0 0 auto; width: 40px; height: 40px; border-radius: var(--radius-md);
    display: flex; align-items: center; justify-content: center;
    background: rgba(74, 158, 255, 0.12); color: var(--accent-blue);
  }
  .guide { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .guide-link {
    display: grid; grid-template-columns: 24px 1fr 16px; align-items: center; gap: var(--space-3);
    padding: var(--space-2) var(--space-2); border-radius: var(--radius-sm);
    color: var(--text-primary); text-decoration: none; font-size: var(--text-sm); line-height: 1.45;
    transition: background var(--transition-fast);
  }
  .guide-link:hover { background: var(--bg-tertiary); color: var(--accent-blue); }
  .guide-num {
    width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--text-xs); font-weight: 700; font-family: var(--font-mono);
  }
  .note { display: flex; align-items: center; gap: var(--space-2); }

  /* path */
  .path-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .progress { display: flex; flex-direction: column; gap: var(--space-1); min-width: 220px; }
  .progress-text { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); }
  .bar { height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent-green, #3fb950); transition: width 0.3s; }
  .trial { font-size: var(--text-xs); color: var(--accent-blue); }
  .trial.ended { color: var(--accent-orange, #d29922); text-decoration: none; font-weight: 600; }

  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .steps li {
    display: grid; grid-template-columns: 32px 1fr; gap: var(--space-3);
    padding: var(--space-3) var(--space-2); border-top: 1px solid var(--border-muted); border-radius: var(--radius-sm);
  }
  .steps li:first-child { border-top: none; }
  .steps li.next { background: rgba(74, 158, 255, 0.08); }
  .num {
    width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--bg-tertiary); color: var(--text-secondary); font-weight: 700; font-family: var(--font-mono); font-size: var(--text-sm);
  }
  li.done .num { background: rgba(63, 185, 80, 0.15); color: var(--accent-green, #3fb950); }
  li.next .num { background: rgba(74, 158, 255, 0.18); color: var(--accent-blue); }
  .step-body { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
  .step-title { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; color: var(--text-primary); }
  .step-title strong { font-size: var(--text-base); font-weight: 600; }
  li.done .step-title strong { color: var(--text-muted); text-decoration: line-through; }
  .state {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 1px 7px; border-radius: var(--radius-full); background: var(--bg-tertiary); color: var(--text-muted);
  }
  li.next .state { background: rgba(74, 158, 255, 0.14); color: var(--accent-blue); }
  li.done .state { background: rgba(63, 185, 80, 0.15); color: var(--accent-green, #3fb950); text-transform: none; letter-spacing: 0; }
  .how { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; }
  .when { font-size: var(--text-xs); }
  .go { align-self: flex-start; font-size: var(--text-sm); font-weight: 600; color: var(--accent-blue); text-decoration: none; padding-top: 2px; }
  .go:hover { text-decoration: underline; }
  .card-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; padding-top: var(--space-2); border-top: 1px solid var(--border-muted); }

  /* more */
  .more { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .more-link {
    display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-muted); border-radius: var(--radius-md); background: var(--bg-primary);
    color: var(--text-secondary); text-decoration: none; font-size: var(--text-sm);
    transition: border-color var(--transition-fast), color var(--transition-fast);
  }
  .more-link:hover { border-color: var(--accent-blue); color: var(--accent-blue); }

  @media (max-width: 768px) {
    .card { padding: var(--space-3) var(--space-4); }
    .steps li { grid-template-columns: 28px 1fr; gap: var(--space-2); }
    .num { width: 28px; height: 28px; }
  }
</style>
