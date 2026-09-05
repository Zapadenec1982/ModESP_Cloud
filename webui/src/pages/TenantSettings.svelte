<script>
  // Organisation settings (plan epic 1.8): what an admin used to ask the founder
  // to change in SQL — time zone, locale, electricity tariff, alarm delays,
  // offline thresholds, acknowledgement escalation.
  import { onMount } from 'svelte'
  import { getTenantSettings, updateTenantSettings, getTenants, getMaintenanceRules, putMaintenanceRule, resetMaintenanceRule } from '../lib/api.js'
  import { currentTenant, isSuperAdmin } from '../lib/stores.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import PageHeader from '../components/layout/PageHeader.svelte'
  import Button from '../components/ui/Button.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import Skeleton from '../components/ui/Skeleton.svelte'
  import EmptyState from '../components/ui/EmptyState.svelte'

  let loading = true
  let error = null
  let saving = false
  let settings = null
  let tenant = null

  // Form model: minutes/seconds for humans, milliseconds on the wire
  let form = {}

  const toMin = (ms) => (ms === null || ms === undefined ? '' : Math.round(ms / 60000))
  const toSec = (ms) => (ms === null || ms === undefined ? '' : Math.round(ms / 1000))
  const fromMin = (v) => (v === '' || v === null ? null : Math.round(Number(v) * 60000))
  const fromSec = (v) => (v === '' || v === null ? null : Math.round(Number(v) * 1000))

  function fill(data) {
    settings = data
    form = {
      timezone: data.timezone || 'Europe/Kyiv',
      locale: data.locale || 'uk',
      electricity_rate: data.electricity_rate === null || data.electricity_rate === undefined ? '' : Number(data.electricity_rate),
      electricity_currency: data.electricity_currency || 'UAH',
      door_min: toMin(data.door_alarm_delay_ms),
      pulldown_min: toMin(data.pulldown_alarm_delay_ms),
      offline_sec: toSec(data.offline_threshold_ms),
      offline_alarm_min: toMin(data.offline_alarm_delay_ms),
      ack_min: data.ack_escalation_min ?? '',
      raw_retention_days: data.raw_retention_days ?? '',
    }
  }

  async function load() {
    loading = true
    try {
      const tenants = await getTenants()
      tenant = tenants.find(x => x.id === $currentTenant?.id) || tenants[0]
      fill(await getTenantSettings(tenant.id))
      error = null
    } catch (e) {
      error = e.message
    } finally {
      loading = false
    }
  }

  async function save() {
    saving = true
    try {
      const data = await updateTenantSettings(tenant.id, {
        timezone: form.timezone,
        locale: form.locale,
        electricity_rate: form.electricity_rate === '' ? null : Number(form.electricity_rate),
        electricity_currency: form.electricity_currency,
        door_alarm_delay_ms: fromMin(form.door_min),
        pulldown_alarm_delay_ms: fromMin(form.pulldown_min),
        offline_threshold_ms: fromSec(form.offline_sec),
        offline_alarm_delay_ms: fromMin(form.offline_alarm_min),
        ack_escalation_min: form.ack_min === '' ? null : Number(form.ack_min),
        ...($isSuperAdmin ? { raw_retention_days: form.raw_retention_days === '' ? null : Number(form.raw_retention_days) } : {}),
      })
      fill(data)
      toast.success($t('settings.saved'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      saving = false
    }
  }

  onMount(load)

  // ── Maintenance hint thresholds (plan epic 2.4) ──
  let rules = []
  let rulesAvailable = true
  let ruleBusy = null
  let ruleForm = {}
  async function loadRules() {
    try {
      rules = await getMaintenanceRules()
      rulesAvailable = true
      // The rule counts alarms over a window the admin thinks of in days; the API keeps hours
      ruleForm = Object.fromEntries(rules.map(r => [r.rule_key, { threshold: r.threshold, window_days: Math.max(1, Math.round((r.window_hours || 168) / 24)), enabled: r.enabled }]))
    } catch (e) {
      // 402: plan without the feature — the section hides itself
      rulesAvailable = false
    }
  }
  onMount(loadRules)
  async function saveRule(key) {
    const f = ruleForm[key]
    ruleBusy = key
    try {
      const days = Math.min(30, Math.max(1, Math.round(Number(f.window_days)) || 7))
      await putMaintenanceRule(key, { threshold: Math.max(1, Math.round(Number(f.threshold)) || 1), window_hours: days * 24, enabled: !!f.enabled })
      toast.success($t('settings.maintenance_saved'))
      await loadRules()
    } catch (e) { toast.error(e.message) } finally { ruleBusy = null }
  }
  async function resetRule(key) {
    ruleBusy = key
    try { await resetMaintenanceRule(key); await loadRules() }
    catch (e) { toast.error(e.message) } finally { ruleBusy = null }
  }
</script>

<div class="settings-page">
  <PageHeader title={$t('pages.settings')} subtitle={tenant ? tenant.name : $t('pages.settings_sub')}>
    <Button variant="secondary" icon="refresh" on:click={load}>{$t('common.refresh')}</Button>
  </PageHeader>

  {#if loading}
    <Skeleton height="320px" />
  {:else if error}
    <EmptyState icon="x-circle" title={$t('common.failed_to_load')} message={error} />
  {:else}
    {#if tenant}
      <section class="section-card">
        <div class="section-header"><Icon name="building" size={16} /><span>{$t('settings.plan_title')}</span></div>
        <div class="plan-grid">
          <div><span class="k">{$t('tenants.col_plan')}</span><strong>{tenant.plan_name || tenant.plan}</strong></div>
          <div><span class="k">{$t('tenants.col_devices')}</span><strong>{tenant.device_count ?? 0}{tenant.max_devices ? ' / ' + tenant.max_devices : ''}</strong></div>
          <div><span class="k">{$t('tenants.col_sites')}</span><strong>{tenant.site_count ?? 0}{tenant.max_sites ? ' / ' + tenant.max_sites : ''}</strong></div>
          <div><span class="k">{$t('tenants.col_users')}</span><strong>{tenant.user_count ?? 0}{tenant.max_users ? ' / ' + tenant.max_users : ''}</strong></div>
          <div><span class="k">{$t('settings.retention')}</span><strong>{settings.retention_days ?? tenant.retention_days ?? '—'} {$t('settings.days')}</strong>{#if settings.raw_retention_days}<span class="k"> · {$t('settings.retention_override')}</span>{/if}</div>
          <div><span class="k">{$t('tenants.col_status')}</span><strong>{$t('tenants.status_' + (tenant.status || 'active'))}</strong></div>
        </div>
        <p class="hint">{$t('settings.plan_hint')}</p>
      </section>
    {/if}

    <form class="section-card" on:submit|preventDefault={save}>
      <div class="section-header"><Icon name="settings" size={16} /><span>{$t('settings.general')}</span></div>
      <div class="form-grid">
        <label class="field"><span>{$t('settings.timezone')}</span><input class="input" bind:value={form.timezone} placeholder="Europe/Kyiv" /></label>
        <label class="field"><span>{$t('settings.locale')}</span>
          <select class="input" bind:value={form.locale}><option value="uk">Українська</option><option value="en">English</option><option value="pl">Polski</option><option value="de">Deutsch</option></select>
        </label>
        <label class="field"><span>{$t('settings.electricity_rate')}</span><input class="input" type="number" step="0.01" min="0" bind:value={form.electricity_rate} placeholder={$t('settings.not_set')} /></label>
        <label class="field"><span>{$t('settings.currency')}</span><input class="input" maxlength="3" bind:value={form.electricity_currency} /></label>
      </div>

      <div class="section-header"><Icon name="alert-triangle" size={16} /><span>{$t('settings.alarms')}</span></div>
      <p class="hint">{$t('settings.alarms_hint')}</p>
      <div class="form-grid">
        <label class="field"><span>{$t('settings.door_delay')}</span><input class="input" type="number" min="0" max="120" bind:value={form.door_min} placeholder={toMin(settings.defaults.door_alarm_delay_ms)} /></label>
        <label class="field"><span>{$t('settings.pulldown_delay')}</span><input class="input" type="number" min="0" max="120" bind:value={form.pulldown_min} placeholder={toMin(settings.defaults.pulldown_alarm_delay_ms)} /></label>
        <label class="field"><span>{$t('settings.offline_threshold')}</span><input class="input" type="number" min="30" max="3600" bind:value={form.offline_sec} placeholder={toSec(settings.defaults.offline_threshold_ms)} /></label>
        <label class="field"><span>{$t('settings.offline_alarm_delay')}</span><input class="input" type="number" min="0" max="1440" bind:value={form.offline_alarm_min} placeholder={toMin(settings.defaults.offline_alarm_delay_ms)} /></label>
        <label class="field"><span>{$t('settings.ack_escalation')}</span><input class="input" type="number" min="1" max="1440" bind:value={form.ack_min} placeholder={settings.defaults.ack_escalation_min} /></label>
      </div>

      {#if $isSuperAdmin}
        <div class="section-header"><Icon name="clock" size={16} /><span>{$t('settings.retention')}</span></div>
        <p class="hint">{$t('settings.retention_override_hint')}</p>
        <div class="form-grid">
          <label class="field"><span>{$t('settings.retention_override')}</span><input class="input" type="number" min="7" max="1100" bind:value={form.raw_retention_days} placeholder={$t('settings.not_set')} /></label>
        </div>
      {/if}
      <div class="actions">
        <Button variant="primary" type="submit" loading={saving} icon="check">{$t('common.save')}</Button>
      </div>
    </form>

    {#if rulesAvailable && rules.length > 0}
      <section class="section-card">
        <div class="section-header"><Icon name="wrench" size={16} /><span>{$t('settings.maintenance_title')}</span></div>
        <p class="hint">{$t('settings.maintenance_hint')}</p>
        <div class="rules">
          {#each rules as r (r.rule_key)}
            <div class="rule-row" class:overridden={r.overridden}>
              <div class="rule-name">
                <strong>{$t(`hint.${r.rule_key}`)}</strong>
                {#if r.default}<span class="muted">{$t('settings.maintenance_default')}: {r.default.threshold} {$t(`hint.unit_${r.rule_key}`)} {$t('hint.window_days').replace('{0}', Math.round((r.default.window_hours || 168) / 24))}</span>{/if}
              </div>
              <label class="field small"><span>{$t('settings.maintenance_threshold')}</span><input class="input" type="number" min="1" step="1" bind:value={ruleForm[r.rule_key].threshold} /></label>
              <label class="field small"><span>{$t('settings.maintenance_window')}</span><input class="input" type="number" min="1" max="30" step="1" bind:value={ruleForm[r.rule_key].window_days} /></label>
              <label class="check"><input type="checkbox" bind:checked={ruleForm[r.rule_key].enabled} /> {$t('settings.maintenance_enabled')}</label>
              <div class="rule-actions">
                <Button size="sm" variant="secondary" disabled={ruleBusy === r.rule_key} on:click={() => saveRule(r.rule_key)}>{$t('settings.maintenance_save')}</Button>
                {#if r.overridden}
                  <Button size="sm" variant="ghost" disabled={ruleBusy === r.rule_key} on:click={() => resetRule(r.rule_key)}>{$t('settings.maintenance_reset')}</Button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .settings-page { display: flex; flex-direction: column; gap: var(--space-4); max-width: 960px; }
  .section-card { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); overflow: hidden; }
  .section-header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-muted); font-weight: 600; font-size: var(--text-sm); }
  .plan-grid, .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); padding: var(--space-4); }
  .plan-grid div { display: flex; flex-direction: column; gap: 2px; }
  .plan-grid .k { font-size: var(--text-xs); color: var(--text-muted); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .input { padding: var(--space-2) var(--space-3); border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-primary); }
  .hint { margin: 0; padding: 0 var(--space-4) var(--space-3); font-size: var(--text-xs); color: var(--text-muted); }
  .actions { display: flex; justify-content: flex-end; padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-muted); }

  .rules { display: grid; gap: var(--space-2); }
  .rule-row {
    display: grid; grid-template-columns: minmax(0, 2fr) 120px 110px auto auto; gap: var(--space-3); align-items: end;
    padding: var(--space-2) var(--space-3); border: 1px solid var(--border-muted); border-radius: var(--radius-md);
  }
  .rule-row.overridden { border-color: var(--accent-blue); }
  .rule-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .rule-name .muted { color: var(--text-secondary); font-size: var(--text-sm); }
  .field.small span { font-size: var(--text-xs); }
  .check { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); padding-bottom: 8px; }
  .rule-actions { display: flex; gap: var(--space-2); padding-bottom: 2px; }
  @media (max-width: 860px) { .rule-row { grid-template-columns: 1fr 1fr; } .rule-name { grid-column: 1 / -1; } }
</style>
