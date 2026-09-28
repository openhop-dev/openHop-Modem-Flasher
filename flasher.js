import "/lib/beer.min.js?v=openhop14";
import { createApp } from "/lib/vue.prod.min.js?v=openhop14";
import ReadMore from '/lib/overflow.vue.js?v=openhop14';
import { createSetup } from '/js/app.js?v=openhop14';
import { loadCatalog } from '/js/catalog.js?v=openhop14';

// Keep the fork's startup semantics: only in-app navigation restores selections.
if(location.pathname !== '/') {
  location.replace('/');
} else {
  const config = await loadCatalog();
  createApp({ setup: createSetup(config), components: { ReadMore } }).mount('#app');
}
