<script>
  import { effectiveTheme, toggleTheme } from '../../lib/theme.js'
  import { locale, setLocale, supportedLocales } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'

  export let compact = false

  let dropdownOpen = false
  let toggleBtn = null
  let dropdownStyle = ''

  function openDropdown() {
    if (toggleBtn) {
      const rect = toggleBtn.getBoundingClientRect()
      const dropdownH = supportedLocales.length * 30 + 8
      const spaceAbove = rect.top
      if (spaceAbove >= dropdownH) {
        dropdownStyle = `position:fixed;bottom:${window.innerHeight - rect.top + 4}px;left:${rect.left}px;min-width:${rect.width}px`
      } else {
        dropdownStyle = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;min-width:${rect.width}px`
      }
    }
    dropdownOpen = !dropdownOpen
  }

  function cycleLocale() {
    const codes = supportedLocales.map(l => l.code)
    const idx = codes.indexOf($locale)
    setLocale(codes[(idx + 1) % codes.length])
  }

  function selectLocale(code) {
    setLocale(code)
    dropdownOpen = false
  }

  function handleClickOutside(e) {
    if (dropdownOpen && !e.target.closest('.lang-selector')) {
      dropdownOpen = false
    }
  }

  $: currentLabel = supportedLocales.find(l => l.code === $locale)?.label || $locale.toUpperCase()
</script>

<svelte:window on:click={handleClickOutside} />

<div class="settings-menu" class:compact>
  <!-- Theme toggle -->
  <button
    class="settings-btn"
    on:click={toggleTheme}
    title={$effectiveTheme === 'dark' ? 'Light theme' : 'Dark theme'}
    aria-label="Toggle theme"
  >
    <Icon name={$effectiveTheme === 'dark' ? 'sun' : 'moon'} size={15} />
  </button>

  <!-- Language selector -->
  {#if !compact}
    <div class="lang-selector">
      <button
        class="lang-toggle"
        bind:this={toggleBtn}
        on:click|stopPropagation={openDropdown}
        aria-label="Select language"
      >
        <span class="lang-label">{currentLabel}</span>
        <svg class="lang-chevron" class:open={dropdownOpen} width="10" height="10" viewBox="0 0 10 10">
          <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      {#if dropdownOpen}
        <div class="lang-dropdown" style={dropdownStyle}>
          {#each supportedLocales as loc}
            <button
              class="lang-option"
              class:active={$locale === loc.code}
              on:click|stopPropagation={() => selectLocale(loc.code)}
            >
              {loc.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <button
      class="settings-btn"
      on:click={cycleLocale}
      title="Language: {currentLabel}"
      aria-label="Toggle language"
    >
      <span class="lang-icon">{currentLabel}</span>
    </button>
  {/if}
</div>

<style>
  .settings-menu {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .settings-menu.compact {
    flex-direction: column;
    align-items: center;
  }

  .settings-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 5px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
  }

  .settings-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border-color: var(--border-muted);
  }

  .lang-selector {
    position: relative;
  }

  .lang-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-muted);
    color: var(--text-secondary);
    cursor: pointer;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    font-family: var(--font-sans);
    letter-spacing: 0.03em;
    transition: all var(--transition-fast);
  }

  .lang-toggle:hover {
    color: var(--text-primary);
    border-color: var(--accent-blue);
  }

  .lang-chevron {
    transition: transform var(--transition-fast);
  }

  .lang-chevron.open {
    transform: rotate(180deg);
  }

  .lang-dropdown {
    background: var(--bg-secondary);
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    padding: 3px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 1000;
  }

  .lang-option {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 3px;
    font-size: var(--text-xs);
    font-weight: 600;
    font-family: var(--font-sans);
    letter-spacing: 0.03em;
    text-align: left;
    transition: all var(--transition-fast);
  }

  .lang-option:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .lang-option.active {
    background: var(--accent-blue);
    color: #fff;
  }

  .lang-icon {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.03em;
  }
</style>
