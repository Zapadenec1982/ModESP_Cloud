// Landing page settings that differ between servers. Lives in shared/landing-config.js
// on the server (deploy.sh links it into every release); plain JS, no build step.
// An empty string hides the corresponding link.
window.MODESP_LANDING = {
  // External platform status page (UptimeRobot / Better Stack), same as VITE_STATUS_PAGE_URL
  statusPageUrl: '',
  // Contact address shown on the pages and used by the form's error message
  contactEmail: 'hello@modesp.com.ua',
};
